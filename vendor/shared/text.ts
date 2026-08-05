/** Strip emoji pictographs from assistant text before display. */
export function stripEmojis(text: string): string {
  return text.replace(/\p{Extended_Pictographic}/gu, '')
}
