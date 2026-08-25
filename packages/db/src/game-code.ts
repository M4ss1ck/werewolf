import { GAME_CODE_ALPHABET, type GameCode } from "@werewolf/protocol";

export { GAME_CODE_ALPHABET } from "@werewolf/protocol";

const CODE_LENGTH = 10;
const ACCEPTED_BYTE_LIMIT = Math.floor(256 / GAME_CODE_ALPHABET.length) * GAME_CODE_ALPHABET.length;

type RandomBytes = (size: number) => Uint8Array;

const systemRandomBytes: RandomBytes = (size) => crypto.getRandomValues(new Uint8Array(size));

/** Generate a canonical ten-character game code without modulo bias. */
export function generateGameCode(randomBytes: RandomBytes = systemRandomBytes): GameCode {
  let code = "";
  while (code.length < CODE_LENGTH) {
    const bytes = randomBytes(CODE_LENGTH - code.length);
    for (const byte of bytes) {
      if (byte >= ACCEPTED_BYTE_LIMIT) continue;
      code += GAME_CODE_ALPHABET[byte % GAME_CODE_ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return code as GameCode;
}
