/**
 * MoodLens meme sharing — Google Apps Script
 *
 * Receives memes from the MoodLens server, saves them in a Drive folder,
 * makes each one viewable by anyone with its link, and permanently deletes
 * memes older than KEEP_DAYS. See README.md ("Kirim ke HP lewat QR") for setup.
 */

const FOLDER_NAME = 'MoodLens Memes';
const KEEP_DAYS = 7;

/**
 * Run once from the editor. Creates the folder, the upload token and the
 * hourly cleanup trigger, then prints the token to copy into the .env file.
 */
function setup() {
  const props = PropertiesService.getScriptProperties();

  let folderId = props.getProperty('FOLDER_ID');
  if (!folderId) {
    folderId = DriveApp.createFolder(FOLDER_NAME).getId();
    props.setProperty('FOLDER_ID', folderId);
  }

  let token = props.getProperty('UPLOAD_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('UPLOAD_TOKEN', token);
  }

  // Hourly, so a meme is gone at most about an hour after its 7 days are up
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'cleanupOldMemes')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('cleanupOldMemes').timeBased().everyHours(1).create();

  Logger.log('Folder: https://drive.google.com/drive/folders/' + folderId);
  Logger.log('DRIVE_UPLOAD_TOKEN=' + token);
}

/** Opening the web app URL in a browser shows this, which confirms the deployment works. */
function doGet() {
  return jsonResponse({ ok: true, service: 'MoodLens meme sharing' });
}

/** Upload endpoint called by the MoodLens server. */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const props = PropertiesService.getScriptProperties();

    if (!body.token || body.token !== props.getProperty('UPLOAD_TOKEN')) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }

    const bytes = Utilities.base64Decode(body.image);
    const stamp = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyyMMdd-HHmmss');
    const name = 'moodlens-' + stamp + '-' + Utilities.getUuid().slice(0, 8) + '.jpg';
    const blob = Utilities.newBlob(bytes, 'image/jpeg', name);

    const folder = DriveApp.getFolderById(props.getProperty('FOLDER_ID'));
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return jsonResponse({
      ok: true,
      url: 'https://drive.google.com/file/d/' + file.getId() + '/view'
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

/** Runs from the hourly trigger. Deletes memes older than KEEP_DAYS for good (not just to the trash). */
function cleanupOldMemes() {
  const folderId = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (!folderId) return;

  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const files = DriveApp.getFolderById(folderId).getFiles();

  while (files.hasNext()) {
    const file = files.next();
    if (file.getDateCreated().getTime() < cutoff) {
      UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + file.getId(), {
        method: 'delete',
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      });
    }
  }
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
