/**
 * Download policy.
 *
 * On Southbag OS the customer has no local file storage: files live in
 * Southbag Drive, so downloads are Drive-first - the bytes pass through a
 * temp file into the customer's Drive and nothing stays on disk (see
 * drive-download.js). The OS marks every process it launches with
 * SOUTHBAG_OS=1 (set by the launch CGI in the os repo). The standalone
 * desktop product never sets it and is unaffected.
 */

const OS_ENV = 'SOUTHBAG_OS';

function runningOnSouthbagOS(env = process.env) {
  return Boolean(env[OS_ENV]);
}

module.exports = { OS_ENV, runningOnSouthbagOS };
