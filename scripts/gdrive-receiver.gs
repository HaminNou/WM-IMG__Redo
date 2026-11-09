/**
 * Google Apps Script receiver for the WM-IMG study data.
 *
 * The study page POSTs one JSON envelope per upload:
 *     { "key": "<UPLOAD_KEY>", "filename": "<name>.json", "data": "<JSON text>" }
 * (sent as text/plain so the browser makes no CORS preflight request).
 * This script writes `data` to a file called `filename` in one private Drive
 * folder and answers, always with HTTP 200 (Apps Script cannot set a status):
 *     { "ok": true }
 *     { "ok": false, "error": "FILE_EXISTS" }   the same name was stored before
 *     { "ok": false, "error": "BAD_KEY" }       wrong upload key
 *     { "ok": false, "error": "BAD_REQUEST" }   malformed body or file name
 *     { "ok": false, "error": "SERVER_ERROR" }  anything else; the page retries
 * The page counts FILE_EXISTS as delivered (src/uploader.js, postWithRetry).
 *
 * SETUP (once, signed in as the account that should own the data)
 *   1. In Drive, create a folder for the study and copy its ID (the last part of
 *      the folder URL). Keep it private: share it only with the research team.
 *   2. Go to script.google.com > New project, paste this file in, and set
 *      Project Settings > Script properties:
 *          FOLDER_ID   = <the folder ID from step 1>
 *          UPLOAD_KEY  = <the same value as config.uploader.gdrive_upload_key
 *                         in src/config.js>
 *   3. Run `selfTest` once from the editor and accept the permission prompt
 *      (Drive access). It writes and deletes a small file in the folder.
 *   4. Deploy > New deployment > type "Web app":
 *          Execute as: Me
 *          Who has access: Anyone
 *      Copy the "Web app" URL (it ends in /exec) into
 *      config.uploader.endpoint, and into pre-reg/pre-reg.json (config_locked).
 *   5. After ANY later edit of this script, use Deploy > Manage deployments >
 *      Edit > New version, or the live URL keeps serving the old code.
 *
 * NOTES
 *   - "Anyone" access is required because participants are not signed in. The
 *     upload key only keeps stray requests out; it ships in the page.
 *   - File names are checked against a strict pattern, so a request cannot
 *     write outside the folder or overwrite another file.
 *   - Each participant gets a subfolder named after the Prolific session id at the start of the
 *     file names (`<session>__<run>__<part>.json`), created on first use; a restart keeps the
 *     session id, so the files of both attempts stay together. Files already in the main folder
 *     can be sorted once with `organizeExistingFiles` (run it from the editor).
 *   - A LockService lock makes the exists-check and the write one step, so two
 *     identical retries cannot both create the file.
 *   - Consumer Gmail accounts allow about 20,000 Drive writes per day and
 *     Apps Script allows about 30 simultaneous executions: far more than the
 *     study needs (about 20 uploads per participant).
 */

var MAX_DATA_CHARS = 5 * 1024 * 1024;
var FILENAME_RE = /^[A-Za-z0-9_-]{1,300}\.json$/;
/* File names start with the participant's Prolific session id: `<session>__<run>__<part>.json`.
 * That id names the participant's subfolder, so one participant's files (including the
 * files of a restart, which keeps the session id) stay together. */
var SESSION_RE = /^([A-Za-z0-9_-]{1,100}?)__/; /* lazy: stops at the FIRST double underscore */
var UNSORTED_FOLDER = '_unsorted';

/**
 * The subfolder of `root` that holds the files of the session named at the start of `filename`
 * (created on first use). A name without a session prefix goes to `_unsorted`. Call it while
 * holding the script lock so that two uploads cannot create the same folder twice.
 */
function subfolderFor_(root, filename) {
  var m = SESSION_RE.exec(filename);
  var name = m ? m[1] : UNSORTED_FOLDER;
  var found = root.getFoldersByName(name);
  return found.hasNext() ? found.next() : root.createFolder(name);
}

function doPost(e) {
  try {
    var props = PropertiesService.getScriptProperties();
    var folderId = props.getProperty('FOLDER_ID');
    var uploadKey = props.getProperty('UPLOAD_KEY');
    if (!folderId || !uploadKey) return reply_({ ok: false, error: 'SERVER_ERROR' });

    var body = e && e.postData && e.postData.contents;
    if (!body) return reply_({ ok: false, error: 'BAD_REQUEST' });
    var msg;
    try {
      msg = JSON.parse(body);
    } catch (err) {
      return reply_({ ok: false, error: 'BAD_REQUEST' });
    }
    if (!msg || typeof msg !== 'object') return reply_({ ok: false, error: 'BAD_REQUEST' });
    if (msg.key !== uploadKey) return reply_({ ok: false, error: 'BAD_KEY' });
    if (typeof msg.filename !== 'string' || !FILENAME_RE.test(msg.filename)) {
      return reply_({ ok: false, error: 'BAD_REQUEST' });
    }
    if (typeof msg.data !== 'string' || msg.data.length === 0 || msg.data.length > MAX_DATA_CHARS) {
      return reply_({ ok: false, error: 'BAD_REQUEST' });
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var root = DriveApp.getFolderById(folderId);
      var folder = subfolderFor_(root, msg.filename);
      if (folder.getFilesByName(msg.filename).hasNext()) {
        return reply_({ ok: false, error: 'FILE_EXISTS' });
      }
      folder.createFile(msg.filename, msg.data, MimeType.PLAIN_TEXT);
    } finally {
      lock.releaseLock();
    }
    return reply_({ ok: true });
  } catch (err) {
    console.error(err);
    return reply_({ ok: false, error: 'SERVER_ERROR' });
  }
}

/** Opening the /exec URL in a browser answers this, which proves the deployment is live. */
function doGet() {
  return reply_({ ok: true, service: 'wm-img-receiver' });
}

/** Run from the editor once (step 3): checks the folder ID, Drive permission and subfolders. */
function selfTest() {
  var folderId = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (!folderId) throw new Error('Set the FOLDER_ID script property first.');
  var root = DriveApp.getFolderById(folderId);
  var sub = subfolderFor_(root, '_selftest' + Date.now() + '__run__part.json');
  sub.createFile('selftest.json', '{"selftest":true}', MimeType.PLAIN_TEXT);
  sub.setTrashed(true);
  console.log(
    'OK: wrote a test file in a new subfolder of "' + root.getName() + '" and removed it.'
  );
}

/**
 * Run from the editor ONCE after switching to subfolders: moves the files that are still loose
 * in the main folder into the subfolder of their session. Files whose names do not start with
 * `<session>__` go to `_unsorted`. It is safe to run again; it only moves loose .json files.
 */
function organizeExistingFiles() {
  var folderId = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (!folderId) throw new Error('Set the FOLDER_ID script property first.');
  var root = DriveApp.getFolderById(folderId);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  var moved = 0;
  try {
    var files = root.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      if (!/\.json$/.test(file.getName())) continue;
      file.moveTo(subfolderFor_(root, file.getName()));
      moved += 1;
    }
  } finally {
    lock.releaseLock();
  }
  console.log('Moved ' + moved + ' file(s) into session subfolders.');
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
