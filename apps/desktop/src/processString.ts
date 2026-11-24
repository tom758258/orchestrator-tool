// Keep CR explicit in the editor; a textarea cannot represent it losslessly.
// Real LF remains a line break. Escape literal backslashes before CR.
export function encodeProcessString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r/g, '\\r')
}

export function decodeProcessString(value: string): string {
  return value.replace(/\\([\\rn])/g, (_, ch: string) => ch === 'r' ? '\r' : ch === 'n' ? '\n' : '\\')
}
