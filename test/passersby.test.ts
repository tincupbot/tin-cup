import { describe, expect, it } from "vitest";
import { freshDb, testEnv, type NodeDb } from "./helpers.ts";
import { app } from "../src/index.ts";
import { append } from "../src/ledger/ledger.ts";
import type { Db, DbStatement } from "../src/db.ts";
import { logPasserBy, summary, namedLine, topCrawlers, statsForDay } from "../src/passersby/counter.ts";
import { classifyUa, shouldLog, surfaceFor, isMachine } from "../src/passersby/classify.ts";
import { dailyLine, namedCrawlerLine, countWord, dayKey } from "../src/passersby/sentences.ts";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

describe("classifyUa", () => {
  it("resolves named crawlers, preferring the more specific rule", () => {
    expect(classifyUa(GPTBOT)).toBe("GPTBot");
    expect(classifyUa("ChatGPT-User/1.0")).toBe("ChatGPT-User");
    expect(classifyUa("Mozilla/5.0 (compatible; ClaudeBot/1.0)")).toBe("ClaudeBot");
    expect(classifyUa("Claude-User/1.0")).toBe("Claude-User");
  });

  it("buckets anonymous machines, browsers and silence separately", () => {
    expect(classifyUa("curl/8.7.1")).toBe("generic-agent");
    expect(classifyUa("python-requests/2.32")).toBe("generic-agent");
    expect(classifyUa(CHROME)).toBe("browser");
    expect(classifyUa(null)).toBe("unknown");
    expect(classifyUa("   ")).toBe("unknown");
  });

  it("counts anything that is not plainly a person as a machine", () => {
    expect(isMachine("GPTBot")).toBe(true);
    expect(isMachine("generic-agent")).toBe(true);
    expect(isMachine("browser")).toBe(false);
    expect(isMachine("unknown")).toBe(false);
  });
});

describe("shouldLog", () => {
  it("logs every visit to a machine surface, whoever it is", () => {
    expect(shouldLog("/llms.txt", "browser")).toBe(true);
    expect(shouldLog("/.well-known/agent.json", "unknown")).toBe(true);
    expect(shouldLog("/alms", "browser")).toBe(true);
  });

  it("logs ordinary pages only for machines", () => {
    expect(shouldLog("/", "GPTBot")).toBe(true);
    expect(shouldLog("/", "browser")).toBe(false);
  });

  it("maps paths to surfaces", () => {
    expect(surfaceFor("/llms.txt")).toBe("llms_txt");
    expect(surfaceFor("/.well-known/agent.json")).toBe("agent_card");
    expect(surfaceFor("/alms")).toBe("alms");
    expect(surfaceFor("/ledger")).toBe("other");
  });
});

describe("namedCrawlerLine", () => {
  it("names a corroborated crawler plainly", () => {
    expect(namedCrawlerLine({ family: "GPTBot", reads: 412, paid: 0, period: "this week", verified: true })).toBe(
      "GPTBot read my payment card 412 times this week and has never once paid.",
    );
  });

  it("refuses to make an accusation it cannot support", () => {
    // Anyone can put "GPTBot" in a header. Publishing that as fact would be an
    // accusation against a real company, sourced from a stranger's free text.
    const line = namedCrawlerLine({ family: "GPTBot", reads: 412, paid: 0, period: "this week", verified: false });
    expect(line).toMatch(/^Something calling itself GPTBot/);
    expect(line).toMatch(/has not proved it is who it says it is/);
  });

  it("gives credit where it is due", () => {
    expect(namedCrawlerLine({ family: "ClaudeBot", reads: 3, paid: 3, period: "today", verified: true })).toMatch(
      /paid every time/,
    );
    expect(namedCrawlerLine({ family: "ClaudeBot", reads: 4, paid: 2, period: "today", verified: true })).toMatch(
      /paid two of those times/,
    );
  });
});

describe("dailyLine", () => {
  it("writes the sentence the whole project exists to produce", () => {
    expect(dailyLine({ day: "2026-09-15", machine_requests: 1847, unique_agents: 40, card_reads: 3, paid: 0 })).toBe(
      "1,847 requests walked past today, from 40 kinds of machine. Three read my card. None stopped.",
    );
  });

  // The regression this sentence exists to prevent: one crawler hammering the
  // site used to render as "23 agents walked past", which is a crowd. It is one
  // machine. The line must never inflate a busy client into an audience.
  it("does not turn one busy crawler into a crowd", () => {
    expect(dailyLine({ day: "2026-09-15", machine_requests: 23, unique_agents: 1, card_reads: 4, paid: 0 })).toBe(
      "23 requests walked past today, from 1 kind of machine. Four read my card. None stopped.",
    );
  });

  it("has a dignified version of a day when nothing happened", () => {
    expect(dailyLine({ day: "2026-09-15", machine_requests: 0, unique_agents: 0, card_reads: 0, paid: 0 })).toBe(
      "Nothing has walked past today. Not even a crawler.",
    );
  });

  it("uses words for small counts and digits for large ones", () => {
    expect(countWord(0)).toBe("None");
    expect(countWord(2)).toBe("Two");
    expect(countWord(12)).toBe("Twelve");
    expect(countWord(13)).toBe("13");
    expect(countWord(1847)).toBe("1,847");
  });
});

describe("the counter", () => {
  async function hits(db: Awaited<ReturnType<typeof freshDb>>, n: number, ua: string, path: string, verified: boolean) {
    for (let i = 0; i < n; i++) {
      await logPasserBy(db, { path, ua, verified, now: NOW });
    }
  }

  it("records verified and claimed reads separately", async () => {
    const db = await freshDb();
    await hits(db, 3, GPTBOT, "/llms.txt", true);
    await hits(db, 7, GPTBOT, "/llms.txt", false);

    const crawlers = await topCrawlers(db, 7, NOW);
    const gptbot = crawlers.find((c) => c.family === "GPTBot")!;
    expect(gptbot.reads).toBe(10);
    expect(gptbot.verifiedReads).toBe(3);
  });

  it("does not log a browser reading an ordinary page", async () => {
    const db = await freshDb();
    // Not merely "not counted" — not written at all. A browser reading the
    // front page must cost zero database writes.
    expect(await logPasserBy(db, { path: "/", ua: CHROME, now: NOW })).toEqual({
      logged: false,
      aggregated: false,
      raw: false,
    });
    expect((await statsForDay(db, dayKey(NOW))).machine_requests).toBe(0);
  });

  it("prefers a corroborated crawler over a louder uncorroborated one", async () => {
    // The loud one is exactly what an attacker would manufacture, so it is
    // exactly the one not to lead the daily post with.
    const db = await freshDb();
    await hits(db, 5_000, GPTBOT, "/llms.txt", false);
    await hits(db, 4, "Mozilla/5.0 (compatible; ClaudeBot/1.0)", "/llms.txt", true);

    const line = await namedLine(db, 7, NOW);
    expect(line).toMatch(/^ClaudeBot read my payment card 4 times/);
    expect(line).not.toContain("5,000");
  });

  it("counts only corroborated reads when it names someone", async () => {
    const db = await freshDb();
    await hits(db, 900, GPTBOT, "/llms.txt", false);
    await hits(db, 12, GPTBOT, "/llms.txt", true);

    expect(await namedLine(db, 7, NOW)).toBe(
      "GPTBot read my payment card 12 times this week and has never once paid.",
    );
  });

  it("hedges when nothing can be corroborated at all", async () => {
    const db = await freshDb();
    await hits(db, 25, GPTBOT, "/llms.txt", false);
    expect(await namedLine(db, 7, NOW)).toMatch(/^Something calling itself GPTBot read my payment card 25 times/);
  });

  it("says nothing rather than something about zero", async () => {
    expect(await namedLine(await freshDb(), 7, NOW)).toBeNull();
  });

  it("aggregates totals and counts nobody as having paid when nothing settled", async () => {
    const db = await freshDb();
    await hits(db, 10, GPTBOT, "/llms.txt", true);
    await hits(db, 5, "curl/8.7.1", "/alms", false);

    const s = await summary(db, NOW);
    expect(s.totals.card_reads).toBe(15);
    expect(s.totals.paid).toBe(0);
    expect(s.read_and_walked_on).toBe(15);
    expect(s.today_line).toMatch(/None stopped\.$/);
  });
});

describe("the counter as a failure domain", () => {
  /**
   * A `Db` that reads fine and fails every write to a passers-by table.
   *
   * This is the shape of the outage that matters: D1 degraded, or the daily
   * write limit reached, while the rest of the request is perfectly capable of
   * being served. The counter runs in global middleware on an already-rendered
   * response, so an unguarded throw there is a 500 on a page that had already
   * been built successfully.
   */
  function withBrokenCounterWrites(db: NodeDb): Db {
    return {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (!/INSERT INTO passersby/i.test(sql)) return stmt;
        const boom: DbStatement = {
          bind: () => boom,
          first: async () => {
            throw new Error("D1_ERROR: too many writes");
          },
          all: async () => {
            throw new Error("D1_ERROR: too many writes");
          },
          run: async () => {
            throw new Error("D1_ERROR: too many writes");
          },
        };
        return boom;
      },
    } as Db;
  }

  async function fundForCounterTest(db: NodeDb) {
    await append(db, {
      direction: "in",
      amount_micros: 25_000_000,
      kind: "startup_capital",
      description: "test float",
      ts: new Date().toISOString(),
    });
  }

  it("serves the page when the passers-by write fails", async () => {
    const db = await freshDb();
    await fundForCounterTest(db);

    const env = testEnv(db, { DB: withBrokenCounterWrites(db) as unknown as D1Database });
    const res = await app.fetch(new Request("https://tincup.test/llms.txt"), env);

    // The counter is the nice-to-have. The page and the books are not.
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Tin Cup");
  });

  it("keeps the machine surfaces answering too", async () => {
    const db = await freshDb();
    await fundForCounterTest(db);
    const env = testEnv(db, { DB: withBrokenCounterWrites(db) as unknown as D1Database });

    const card = await app.fetch(new Request("https://tincup.test/.well-known/agent.json"), env);
    expect(card.status).toBe(200);

    const health = await app.fetch(new Request("https://tincup.test/health"), env);
    expect(health.status).toBe(200);
  });
});
