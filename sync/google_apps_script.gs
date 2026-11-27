/**
 * Technion Study Hub — Automatic Nightly Sync (Google Drive + Google Calendar -> GitHub Pages)
 *
 * התקנה חד-פעמית (2 דקות):
 * 1. פתח https://script.google.com -> New project -> הדבק את הקוד הזה ושמור.
 * 2. לחץ על גלגל השיניים (Project Settings) -> Script Properties -> הוסף 2 מפתחות:
 *    - GEMINI_API_KEY : מפתח חינמי מ-https://aistudio.google.com/apikey
 *    - GITHUB_TOKEN   : Fine-grained PAT מ-GitHub עם הרשאת Contents: Read & Write לריפו technion-study-hub
 * 3. הרץ פעם אחת את הפונקציה setupDailyTrigger() (ואשר הרשאות Google Drive + Calendar).
 * 4. מעכשיו בכל לילה ב-02:00 (או בלחיצה על Run -> syncNow) האתר מתעדכן אוטומטית!
 */

const CONFIG = {
  DRIVE_ROOT_FOLDER_ID: '1C0AEbdpb-0h6ihySGMwCAcF3bOAAbixa',
  GITHUB_OWNER: 'saharkandel1-maker',
  GITHUB_REPO: 'technion-study-hub',
  GITHUB_BRANCH: 'main',
  DATA_PATH: 'data.json',
  GEMINI_MODEL: 'gemini-2.5-flash',
  MAX_FILES_PER_RUN: 3,
  MAX_FILE_BYTES: 12 * 1024 * 1024, // 12 MB
  CALENDAR_DAYS_UPCOMING: 21,
  CALENDAR_DAYS_EXAMS: 75,
  CALENDAR_KEYWORDS: /HW|WeBWorK|בוחן|מבחן|מועד|הגשה|Quiz|Midterm|Exam|Assignment|ש"ב|תרגיל בית|Moodle|GR/i,
  CALENDAR_EXCLUDE: /-\s*הרצאה|-\s*תרגול|\bהרצאה\b|\bתרגול\b|סדנה|מעבדה|שעת קבלה/i,
  EXAM_KEYWORDS: /בוחן|מבחן|מועד|Midterm|Exam/i
};

const COURSE_LABELS = {
  alg: 'אלגברה 1מ3',
  calc: 'חדו"א 1מ2',
  cs: 'מבוא למדמ"ח',
  ie: 'מבוא לתעו"נ',
  eng: 'אנגלית 03240033'
};

/**
 * הרץ פעם אחת כדי להפעיל סנכרון אוטומטי כל לילה ב-02:00 + להריץ סנכרון ראשוני מיד.
 */
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'syncNow') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncNow')
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .create();
  Logger.log('Daily trigger created for 02:00. Running initial sync...');
  syncNow();
}

/**
 * הפונקציה הראשית — מעדכנת דדליינים מהיומן + קבצים חדשים מ-Drive ודוחפת ל-GitHub.
 */
function syncNow() {
  const props = PropertiesService.getScriptProperties();
  const geminiKey = props.getProperty('GEMINI_API_KEY');
  const githubToken = props.getProperty('GITHUB_TOKEN');
  if (!githubToken) throw new Error('חסר GITHUB_TOKEN ב-Script Properties');

  const ghFile = fetchGitHubDataJson(githubToken);
  const data = ghFile.data;
  data.processedFiles = data.processedFiles || {};
  data.theoremBank = data.theoremBank || [];
  data.quizData = data.quizData || [];
  data.allCards = data.allCards || [];

  let changed = false;

  // 1. Sync upcoming assignments & exams from Google Calendar
  const calResult = syncCalendarEvents(data);
  if (calResult.changed) changed = true;

  // 2. Scan Google Drive for new presentations / lecture notes / homeworks
  const newFiles = findUnprocessedDriveFiles(CONFIG.DRIVE_ROOT_FOLDER_ID, data.processedFiles);
  Logger.log('Unprocessed Drive files found: ' + newFiles.length);

  if (geminiKey && newFiles.length > 0) {
    const batch = newFiles.slice(0, CONFIG.MAX_FILES_PER_RUN);
    for (const item of batch) {
      try {
        Logger.log('Processing: ' + item.name + ' (' + item.course + ')');
        const extracted = extractStudyItemsWithGemini(item, geminiKey);
        const added = mergeExtractedItems(data, extracted, item);
        data.processedFiles[item.id] = {
          name: item.name,
          course: item.course,
          processedAt: new Date().toISOString().slice(0, 10),
          added: added
        };
        changed = true;
        Logger.log('Added from ' + item.name + ': ' + JSON.stringify(added));
      } catch (err) {
        Logger.log('Failed processing ' + item.name + ': ' + err.message);
      }
    }
    if (newFiles.length > CONFIG.MAX_FILES_PER_RUN) {
      Logger.log((newFiles.length - CONFIG.MAX_FILES_PER_RUN) + ' files queued for next run.');
    }
  } else if (!geminiKey && newFiles.length > 0) {
    Logger.log('GEMINI_API_KEY not set — skipped Drive AI extraction (Calendar still synced).');
  }

  if (changed) {
    data.lastUpdated = Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd HH:mm');
    commitGitHubDataJson(githubToken, data, ghFile.sha);
    Logger.log('Successfully updated data.json on GitHub!');
  } else {
    Logger.log('No changes detected — skipping GitHub commit.');
  }
}

// === CALENDAR SYNC ===
function syncCalendarEvents(data) {
  const now = new Date();
  const endUpcoming = new Date(now.getTime() + CONFIG.CALENDAR_DAYS_UPCOMING * 86400000);
  const endExams = new Date(now.getTime() + CONFIG.CALENDAR_DAYS_EXAMS * 86400000);
  const cal = CalendarApp.getDefaultCalendar();
  const events = cal.getEvents(now, endExams);

  const upcoming = [];
  const exams = [];
  const seenExam = {};

  for (const ev of events) {
    const title = (ev.getTitle() || '').trim();
    if (!title || !CONFIG.CALENDAR_KEYWORDS.test(title) || CONFIG.CALENDAR_EXCLUDE.test(title)) continue;
    const start = ev.getStartTime();
    const dateStr = Utilities.formatDate(start, 'Asia/Jerusalem', 'yyyy-MM-dd');
    const timeStr = ev.isAllDayEvent() ? '' : Utilities.formatDate(start, 'Asia/Jerusalem', 'HH:mm');
    const course = detectCourse(title);

    if (CONFIG.EXAM_KEYWORDS.test(title) && !seenExam[title + dateStr]) {
      seenExam[title + dateStr] = true;
      const cleanName = title.replace(/\s*\(\d+\)\s*/g, '').trim();
      exams.push({ name: cleanName, date: dateStr });
    }
    if (start <= endUpcoming) {
      upcoming.push({ title: title, date: dateStr, time: timeStr, course: course });
    }
  }

  upcoming.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  exams.sort((a, b) => a.date.localeCompare(b.date));

  const nextUpcoming = upcoming.slice(0, 12);
  const nextExams = exams.length ? exams.slice(0, 5) : data.exams;

  const changed =
    JSON.stringify(data.upcoming || []) !== JSON.stringify(nextUpcoming) ||
    JSON.stringify(data.exams || []) !== JSON.stringify(nextExams);

  data.upcoming = nextUpcoming;
  data.exams = nextExams;
  return { changed: changed };
}

// === DRIVE SCANNER ===
function detectCourse(text) {
  const s = (text || '').toLowerCase();
  if (/אלגברה|algebra|104067|01040067|hw05|מרחבים|מטריצ/.test(s)) return 'alg';
  if (/חדו|calc|1040042|01040042|גבול|אינטגרל|לופיטל/.test(s)) return 'calc';
  if (/מדמ|python|2340221|02340221|\bcs\b|webcourse|\bgr\b/.test(s)) return 'cs';
  if (/תעו|94101|00940101|תעשיה|תרמיל|תכנות דינמי/.test(s)) return 'ie';
  if (/אנגלית|english|3240033|03240033/.test(s)) return 'eng';
  return 'alg';
}

function findUnprocessedDriveFiles(rootFolderId, processedMap) {
  const results = [];
  const root = DriveApp.getFolderById(rootFolderId);

  function walk(folder, pathHint) {
    const files = folder.getFiles();
    while (files.hasNext()) {
      const f = files.next();
      const id = f.getId();
      if (processedMap[id]) continue;
      const mime = f.getMimeType();
      const supported = [
        'application/pdf',
        'application/vnd.google-apps.document',
        'application/vnd.google-apps.presentation',
        'text/plain',
        'text/markdown'
      ];
      if (supported.indexOf(mime) === -1) continue;
      if (mime === 'application/pdf' && f.getSize() > CONFIG.MAX_FILE_BYTES) continue;

      const name = f.getName();
      const course = detectCourse(pathHint + ' ' + name);
      // Before Calculus midterm (2026-12-14), skip post-midterm sheets (L'Hopital / integrals) so they auto-unlock right after the midterm
      const isBeforeCalcMidterm = new Date() < new Date('2026-12-15T00:00:00+02:00');
      if (isBeforeCalcMidterm && course === 'calc' && /לופיטל|l.?hopital|אינטגרל|integral|דף\s*[89]|טיילור|taylor/i.test(name)) {
        continue;
      }
      results.push({
        id: id,
        name: name,
        mime: mime,
        course: course,
        updated: f.getLastUpdated().getTime()
      });
    }
    const subs = folder.getFolders();
    while (subs.hasNext()) {
      const sub = subs.next();
      walk(sub, pathHint + ' ' + sub.getName());
    }
  }

  walk(root, root.getName());
  results.sort((a, b) => b.updated - a.updated); // Newest files first
  return results;
}

// === GEMINI EXTRACTION ===
function extractStudyItemsWithGemini(item, apiKey) {
  const file = DriveApp.getFileById(item.id);
  const parts = [];
  const isBeforeCalcMidterm = new Date() < new Date('2026-12-15T00:00:00+02:00');

  const prompt = [
    'אתה מתרגל מצטיין בטכניון. נתח את קובץ הקורס המצורף (' + COURSE_LABELS[item.course] + ' — ' + item.name + ').',
    'חלץ אך ורק תוכן מדויק שמופיע ישירות בקובץ (בלי להמציא), בעברית ברורה עם סימונים מתמטיים נקיים (כמו ∈, ≤, ⇒, ⇔, ∞).',
    (isBeforeCalcMidterm && item.course === 'calc') ? 'חשוב: אנחנו לפני בוחן האמצע בחדו"א (14.12) — אל תחלץ שאלות או משפטים על כלל לופיטל, אינטגרלים או פיתוחי טיילור.' : '',
    'החזר JSON תקין בדיוק במבנה הבא:',
    '{',
    '  "theorems": [{ "topic": "שם הנושא הקצר", "kind": "משפט|הגדרה|נוסחה", "title": "כותרת קצרה", "body": "ניסוח מדויק ותמציתי", "trap": "מלכודת בוחן או תנאי קריטי" }],',
    '  "flashcards": [{ "q": "שאלת הבנה/מלכודת קצרה", "a": "תשובה חדה ומדויקת" }],',
    '  "quizItems": [{ "set": "שם קצר לסט התרגול (למשל: אלגברה HW06 — תלות לינארית)", "q": "טענה או שאלת נכון/לא נכון", "ans": true, "exp": "נימוק קצר בשורה אחת", "deep": "הסבר מעמיק שלב-אחר-שלב עם הוכחה קצרה או דוגמה נגדית מפורטת וטיפ לבוחן" }]',
    '}',
    'כללים:',
    '- עד 5 משפטים/הגדרות חשובים באמת, עד 4 כרטיסיות, עד 4 שאלות תרגול נכון/לא נכון.',
    '- אם הקובץ הוא קובץ מנהלתי/סילבוס ללא חומר לימוד, החזר מערכים ריקים.'
  ].filter(Boolean).join('\n');

  parts.push({ text: prompt });

  if (item.mime === 'application/pdf') {
    const b64 = Utilities.base64Encode(file.getBlob().getBytes());
    parts.push({ inline_data: { mime_type: 'application/pdf', data: b64 } });
  } else if (item.mime === 'application/vnd.google-apps.presentation') {
    const pdfBlob = file.getAs('application/pdf');
    if (pdfBlob.getBytes().length > CONFIG.MAX_FILE_BYTES) throw new Error('Slides PDF > 12MB');
    parts.push({ inline_data: { mime_type: 'application/pdf', data: Utilities.base64Encode(pdfBlob.getBytes()) } });
  } else if (item.mime === 'application/vnd.google-apps.document') {
    const txt = DocumentApp.openById(item.id).getBody().getText().slice(0, 45000);
    parts.push({ text: 'תוכן המסמך:\n' + txt });
  } else {
    const txt = file.getBlob().getDataAsString('UTF-8').slice(0, 45000);
    parts.push({ text: 'תוכן הקובץ:\n' + txt });
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + CONFIG.GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ parts: parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2
      }
    })
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Gemini API ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 250));
  }
  const body = JSON.parse(res.getContentText());
  const rawText = body.candidates[0].content.parts[0].text;
  return JSON.parse(rawText);
}

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[\s"'״׳\-–—.,:;()]+/g, '');
}

function mergeExtractedItems(data, extracted, item) {
  const added = { theorems: 0, flashcards: 0, quizItems: 0 };
  const existingThm = new Set(data.theoremBank.map(x => normKey(x.title)));
  const existingCards = new Set(data.allCards.map(x => normKey(x.q)));
  const existingQuiz = new Set(data.quizData.map(x => normKey(x.q)));
  const shortId = item.id.slice(0, 6);

  (extracted.theorems || []).forEach((t, idx) => {
    if (!t.title || !t.body || existingThm.has(normKey(t.title))) return;
    existingThm.add(normKey(t.title));
    data.theoremBank.push({
      id: 'auto_' + shortId + '_t' + idx,
      c: item.course,
      topic: t.topic || 'חומר חדש',
      kind: ['הגדרה', 'משפט', 'נוסחה'].indexOf(t.kind) !== -1 ? t.kind : 'משפט',
      title: t.title,
      body: t.body,
      trap: t.trap || 'בדוק היטב את כל תנאי המשפט לפני השימוש.',
      source: item.name
    });
    added.theorems++;
  });

  (extracted.flashcards || []).forEach((fc, idx) => {
    if (!fc.q || !fc.a || existingCards.has(normKey(fc.q))) return;
    existingCards.add(normKey(fc.q));
    data.allCards.push({
      id: 'auto_' + shortId + '_c' + idx,
      d: item.course,
      c: COURSE_LABELS[item.course] || item.course,
      q: fc.q,
      a: fc.a,
      source: item.name
    });
    added.flashcards++;
  });

  (extracted.quizItems || []).forEach(qz => {
    if (!qz.q || typeof qz.ans !== 'boolean' || !qz.exp || existingQuiz.has(normKey(qz.q))) return;
    existingQuiz.add(normKey(qz.q));
    data.quizData.push({
      c: item.course,
      set: qz.set || (COURSE_LABELS[item.course] + ' — ' + item.name.replace(/\.[^.]+$/, '')),
      q: qz.q,
      ans: qz.ans,
      exp: qz.exp,
      deep: qz.deep || ''
    });
    added.quizItems++;
  });

  return added;
}

// === GITHUB API ===
function fetchGitHubDataJson(token) {
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' + CONFIG.DATA_PATH + '?ref=' + CONFIG.GITHUB_BRANCH;
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json'
    }
  });
  if (res.getResponseCode() === 404) {
    return { sha: null, data: { lastUpdated: '', exams: [], upcoming: [], processedFiles: {}, theoremBank: [], quizData: [], allCards: [] } };
  }
  if (res.getResponseCode() !== 200) {
    throw new Error('GitHub GET failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  }
  const obj = JSON.parse(res.getContentText());
  const decoded = Utilities.newBlob(Utilities.base64Decode(obj.content.replace(/\s+/g, ''))).getDataAsString('UTF-8');
  return { sha: obj.sha, data: JSON.parse(decoded) };
}

function commitGitHubDataJson(token, data, sha) {
  const url = 'https://api.github.com/repos/' + CONFIG.GITHUB_OWNER + '/' + CONFIG.GITHUB_REPO + '/contents/' + CONFIG.DATA_PATH;
  const jsonStr = JSON.stringify(data, null, 2);
  const payload = {
    message: 'Auto-sync Technion Study Hub (' + data.lastUpdated + ')',
    content: Utilities.base64Encode(jsonStr, Utilities.Charset.UTF_8),
    branch: CONFIG.GITHUB_BRANCH
  };
  if (sha) payload.sha = sha;

  const res = UrlFetchApp.fetch(url, {
    method: 'put',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json'
    },
    payload: JSON.stringify(payload)
  });
  if (res.getResponseCode() !== 200 && res.getResponseCode() !== 201) {
    throw new Error('GitHub PUT failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 250));
  }
}
