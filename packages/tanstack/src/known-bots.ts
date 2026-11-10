/**
 * The one list of known bots and crawlers, used by `createBotVisitMiddleware`
 * (bot-visits.ts) to record bot visits for reporting. Each entry has a name and
 * a category; to add a bot, add one entry here. The resolver checks only the
 * shape of a name and the category set, so a new entry needs no resolver change.
 *
 * Matching (`matchBot`) is case-insensitive and on a token boundary: `name`
 * must appear in the user agent with no letter or digit directly before or
 * after it (so `Applebot` matches `Applebot/0.1` but not `XApplebotY`).
 * Entries are tried in list order and the first match wins, so a longer name
 * that contains a shorter one comes first (`Applebot-Extended` before
 * `Applebot`). The `other` entries come last and match any product token that
 * ends in "bot", "crawler" or "spider".
 *
 * Note: `Google-Extended` and `Applebot-Extended` are robots.txt control tokens.
 * Google and Apple crawl with `Googlebot` and `Applebot`, so in practice those
 * two entries match nothing; they are listed so that any agent that does send
 * them is named correctly.
 *
 * Only the name, the category and one short product token (`userAgentFamily`)
 * leave this module. The user agent itself is never returned, stored or logged.
 */

export const BOT_CATEGORIES = ["ai_crawler", "search_engine", "seo_tool", "social_preview", "monitoring", "other"] as const;
export type BotCategory = (typeof BOT_CATEGORIES)[number];

export interface KnownBot {
  /** Reported as `bot_name`. For a named bot, also the text matched in the user agent. */
  readonly name: string;
  readonly category: BotCategory;
}

export const KNOWN_BOTS: readonly KnownBot[] = [
  // AI crawlers, assistants and AI training opt-out agents
  { name: "GPTBot", category: "ai_crawler" },
  { name: "OAI-SearchBot", category: "ai_crawler" },
  { name: "ChatGPT-User", category: "ai_crawler" },
  { name: "ClaudeBot", category: "ai_crawler" },
  { name: "Claude-User", category: "ai_crawler" },
  { name: "PerplexityBot", category: "ai_crawler" },
  { name: "Perplexity-User", category: "ai_crawler" },
  { name: "Google-Extended", category: "ai_crawler" },
  { name: "Applebot-Extended", category: "ai_crawler" },
  { name: "CCBot", category: "ai_crawler" },
  { name: "Bytespider", category: "ai_crawler" },
  { name: "Meta-ExternalAgent", category: "ai_crawler" },
  { name: "Amazonbot", category: "ai_crawler" },
  // Search engines
  { name: "Googlebot", category: "search_engine" },
  { name: "Bingbot", category: "search_engine" },
  { name: "DuckDuckBot", category: "search_engine" },
  { name: "YandexBot", category: "search_engine" },
  { name: "Applebot", category: "search_engine" },
  // SEO tools
  { name: "AhrefsBot", category: "seo_tool" },
  { name: "SemrushBot", category: "seo_tool" },
  { name: "MJ12bot", category: "seo_tool" },
  { name: "DotBot", category: "seo_tool" },
  // Link previews
  { name: "facebookexternalhit", category: "social_preview" },
  { name: "LinkedInBot", category: "social_preview" },
  { name: "Twitterbot", category: "social_preview" },
  { name: "Slackbot", category: "social_preview" },
  { name: "WhatsApp", category: "social_preview" },
  { name: "Discordbot", category: "social_preview" },
  // Uptime monitoring
  { name: "UptimeRobot", category: "monitoring" },
  { name: "Pingdom", category: "monitoring" },
  // Anything else that calls itself a bot, crawler or spider (matched by token suffix, see matchBot)
  { name: "Generic bot", category: "other" },
  { name: "Generic crawler", category: "other" },
  { name: "Generic spider", category: "other" },
];

export interface BotMatch {
  botName: string;
  botCategory: BotCategory;
  /** The product token that identified the bot, without its version (e.g. `Googlebot-Image`, `PetalBot`). */
  userAgentFamily: string;
}

/** Only the first 512 characters of a user agent are examined (bounded work per request). */
export const USER_AGENT_SCAN_MAX = 512;
const FAMILY_MAX = 64;
const TOKEN_CHAR = /[A-Za-z0-9_-]/;
const ALNUM = /[A-Za-z0-9]/;
/** Product tokens, e.g. `Mozilla`, `PetalBot`, `Googlebot-Image`: letters, digits, `_` and `-`. */
const TOKEN = /[A-Za-z0-9_-]+/g;
/** A generic bot token: ends in bot, crawler or spider, optionally followed by `-suffix` parts (`AdsBot-Google`). */
const GENERIC = /^[A-Za-z0-9_]*?(bot|crawler|spider)(?:-[A-Za-z0-9_]+)*$/i;
/** Tokens that end in "bot" but name a device, not a bot (the Cubot phone brand appears in Android user agents). */
const NOT_BOTS = new Set(["cubot"]);

const NAMED = KNOWN_BOTS.filter((b) => b.category !== "other").map((b) => ({ ...b, lower: b.name.toLowerCase() }));
const GENERIC_NAMES: Record<string, string> = { bot: "Generic bot", crawler: "Generic crawler", spider: "Generic spider" };

/** The token that starts at `start`, cut to the family limit; the version after `/` is never part of it. */
function tokenAt(ua: string, start: number): string {
  let end = start;
  while (end < ua.length && end - start < FAMILY_MAX && TOKEN_CHAR.test(ua[end]!)) end++;
  return ua.slice(start, end);
}

function findNamed(ua: string, lower: string): BotMatch | null {
  for (const bot of NAMED) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(bot.lower, from);
      if (i === -1) break;
      const before = i === 0 ? "" : ua[i - 1]!;
      const after = ua[i + bot.lower.length] ?? "";
      if (!ALNUM.test(before) && !ALNUM.test(after)) {
        return { botName: bot.name, botCategory: bot.category, userAgentFamily: tokenAt(ua, i) };
      }
      from = i + 1;
    }
  }
  return null;
}

function findGeneric(ua: string): BotMatch | null {
  TOKEN.lastIndex = 0;
  for (const m of ua.matchAll(TOKEN)) {
    const token = m[0];
    if (token.length > FAMILY_MAX || NOT_BOTS.has(token.toLowerCase())) continue;
    const g = GENERIC.exec(token);
    if (g) return { botName: GENERIC_NAMES[g[1]!.toLowerCase()]!, botCategory: "other", userAgentFamily: token };
  }
  return null;
}

/**
 * Returns the bot a user agent belongs to, or null for anything else
 * (including a missing or empty user agent). Never throws.
 */
export function matchBot(userAgent: string | null | undefined): BotMatch | null {
  if (typeof userAgent !== "string") return null;
  const ua = userAgent.slice(0, USER_AGENT_SCAN_MAX);
  if (ua.trim() === "") return null;
  return findNamed(ua, ua.toLowerCase()) ?? findGeneric(ua);
}
