/**
 * Download policy.
 *
 * On Southbag OS the customer has no local file storage: files live in
 * Southbag Drive, and downloads do not work. The OS marks every process it
 * launches with SOUTHBAG_OS=1 (set by the launch CGI in the os repo), and
 * the browser refuses downloads while it carries that mark. The standalone
 * desktop product never sets it and is unaffected.
 */

const OS_ENV = 'SOUTHBAG_OS';

function runningOnSouthbagOS(env = process.env) {
  return Boolean(env[OS_ENV]);
}

module.exports = { OS_ENV, runningOnSouthbagOS };
