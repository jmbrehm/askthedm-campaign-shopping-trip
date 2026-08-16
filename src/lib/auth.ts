const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/
const AUTH_EMAIL_DOMAIN = 'users.askthedm.invalid'

export function normalizeUsername(username: string) {
  return username.trim()
}

export function validateUsername(username: string) {
  return USERNAME_PATTERN.test(normalizeUsername(username))
}

export function usernameToAuthEmail(username: string) {
  return `${normalizeUsername(username).toLowerCase()}@${AUTH_EMAIL_DOMAIN}`
}
