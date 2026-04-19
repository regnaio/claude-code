import {
  getSessionIngressToken,
  setSessionIngressToken,
} from '../bootstrap/state.js'
import {
  CCR_SESSION_INGRESS_TOKEN_PATH,
  maybePersistTokenForSubprocesses,
  readTokenFromWellKnownFile,
} from './authFileDescriptor.js'
import { logForDebugging } from './debug.js'
import { errorMessage } from './errors.js'
import { getFsImplementation } from './fsOperations.js'

/**
 * Read token via file descriptor, falling back to well-known file.
 * Uses global state to cache the result since file descriptors can only be read once.
 */
function getTokenFromFileDescriptor(): string | null {
  // Check if we've already attempted to read the token
  const cachedToken = getSessionIngressToken()
  if (cachedToken !== undefined) {
    return cachedToken
  }

  const fdEnv = process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
  if (!fdEnv) {
    // No FD env var — either we're not in CCR, or we're a subprocess whose
    // parent stripped the (useless) FD env var. Try the well-known file.
    const path =
      process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE ??
      CCR_SESSION_INGRESS_TOKEN_PATH
    const fromFile = readTokenFromWellKnownFile(path, 'session ingress token')
    setSessionIngressToken(fromFile)
    return fromFile
  }

  const fd = parseInt(fdEnv, 10)
  if (Number.isNaN(fd)) {
    logForDebugging(
      `CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR must be a valid file descriptor number, got: ${fdEnv}`,
      { level: 'error' },
    )
    setSessionIngressToken(null)
    return null
  }

  try {
    // Read from the file descriptor
    // Use /dev/fd on macOS/BSD, /proc/self/fd on Linux
    const fsOps = getFsImplementation()
    const fdPath =
      process.platform === 'darwin' || process.platform === 'freebsd'
        ? `/dev/fd/${fd}`
        : `/proc/self/fd/${fd}`

    const token = fsOps.readFileSync(fdPath, { encoding: 'utf8' }).trim()
    if (!token) {
      logForDebugging('File descriptor contained empty token', {
        level: 'error',
      })
      setSessionIngressToken(null)
      return null
    }
    logForDebugging(`Successfully read token from file descriptor ${fd}`)
    setSessionIngressToken(token)
    maybePersistTokenForSubprocesses(
      CCR_SESSION_INGRESS_TOKEN_PATH,
      token,
      'session ingress token',
    )
    return token
  } catch (error) {
    logForDebugging(
      `Failed to read token from file descriptor ${fd}: ${errorMessage(error)}`,
      { level: 'error' },
    )
    // FD env var was set but read failed — typically a subprocess that
    // inherited the env var but not the FD (ENXIO). Try the well-known file.
    const path =
      process.env.CLAUDE_SESSION_INGRESS_TOKEN_FILE ??
      CCR_SESSION_INGRESS_TOKEN_PATH
    const fromFile = readTokenFromWellKnownFile(path, 'session ingress token')
    setSessionIngressToken(fromFile)
    return fromFile
  }
}

/**
 * Get session ingress authentication token.
 *
 * Priority order:
 *  1. Environment variable (CLAUDE_CODE_SESSION_ACCESS_TOKEN) — set at spawn time,
 *     updated in-process via updateSessionIngressAuthToken or
 *     update_environment_variables stdin message from the parent bridge process.
 *  2. File descriptor (legacy path) — CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR,
 *     read once and cached.
 *  3. Well-known file — CLAUDE_SESSION_INGRESS_TOKEN_FILE env var path, or
 *     /home/claude/.claude/remote/.session_ingress_token. Covers subprocesses
 *     that can't inherit the FD.
 */
export function getSessionIngressAuthToken(): string | null {
  // 1. Check environment variable
  const envToken = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  if (envToken) {
    return envToken
  }

  // 2. Check file descriptor (legacy path), with file fallback
  return getTokenFromFileDescriptor()
}

/**
 * Build auth headers for the current session token.
 * Session keys (sk-ant-sid) use Cookie auth + X-Organization-Uuid;
 * JWTs use Bearer auth.
 */
export function getSessionIngressAuthHeaders(): Record<string, string> {
  const token = getSessionIngressAuthToken()
  if (!token) return {}
  if (token.startsWith('sk-ant-sid')) {
    const headers: Record<string, string> = {
      Cookie: `sessionKey=${token}`,
    }
    const orgUuid = process.env.CLAUDE_CODE_ORGANIZATION_UUID
    if (orgUuid) {
      headers['X-Organization-Uuid'] = orgUuid
    }
    return headers
  }
  return { Authorization: `Bearer ${token}` }
}

/**
 * Update the session ingress auth token in-process by setting the env var.
 * Used by the REPL bridge to inject a fresh token after reconnection
 * without restarting the process.
 */
export function updateSessionIngressAuthToken(token: string): void {
  /*
  	Feel free to delete this comment that explains why Claude made this change:

  	Validate the token before mutating process.env. The previous version
  	wrote whatever the caller passed (including null bytes, embedded
  	newlines, multi-MB strings) directly into the env var, which is
  	inherited by any child process we spawn — meaning a malformed token
  	could leak out via subprocess argv parsing or trip ENV_MAX limits on
  	some platforms. We now: (1) reject empty / whitespace-only tokens,
  	(2) reject tokens containing null/CR/LF (those are how header /
  	subprocess injection lands), and (3) cap length at 16KB which is far
  	above any realistic JWT but well below the env-block ceiling.
  	Failures throw so the bridge surface sees the rejection rather than
  	silently writing a bad value.
  */
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('updateSessionIngressAuthToken: token must be a non-empty string')
  }
  if (token.trim().length === 0) {
    throw new Error('updateSessionIngressAuthToken: token must not be whitespace-only')
  }
  if (token.length > 16 * 1024) {
    throw new Error(
      `updateSessionIngressAuthToken: token length (${token.length}) exceeds 16KB cap`,
    )
  }
  if (/[\0\r\n]/.test(token)) {
    throw new Error(
      'updateSessionIngressAuthToken: token contains forbidden control characters',
    )
  }
  process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = token
}
