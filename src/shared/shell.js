/** POSIX shell quoting, only when needed so the terminal shows readable commands. */
export function shellQuote(value) {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
