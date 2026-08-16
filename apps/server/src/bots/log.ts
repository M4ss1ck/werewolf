// Structured bot logging. One JSON line per event, with stable field names so
// a match can be followed or aggregated.
//
// Never logged: API keys, and any hidden state beyond the deciding bot's own.
// Prompts and raw responses are logged only when BOT_LOG_PROMPTS is on, since
// a prompt necessarily contains that bot's own role.

export type BotLogFields = Record<string, string | number | boolean | undefined>;
export type BotLogger = (event: string, fields: BotLogFields) => void;

export const consoleBotLogger: BotLogger = (event, fields) => {
  console.log(JSON.stringify({ scope: "bot", event, ...fields }));
};

export const silentBotLogger: BotLogger = () => {};
