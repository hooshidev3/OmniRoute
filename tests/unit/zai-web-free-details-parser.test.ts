/**
 * Comprehensive tests for the new stateful <details> parser.
 *
 * These tests cover all the edge cases that the original buggy parser
 * failed on, plus the scenarios from the user's bug report.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDetailsParser } from "../../open-sse/executors/zai-web-free/detailsParser.ts";

describe("zai-web-free <details> parser (stateful)", () => {
  it('SCENARIO A: <details open="true">...</details> arrives in ONE chunk', () => {
    const parser = createDetailsParser();
    const chunk = `<details open="true">\n> The user is asking...\n> \n> I should emphasize...\n</details>\n\nFinal answer here.`;

    const { contentDelta, reasoningDelta } = parser.push(chunk);

    assert.ok(
      contentDelta.includes("Final answer here."),
      `content should include final answer; got: ${JSON.stringify(contentDelta)}`
    );
    assert.ok(
      !contentDelta.includes("<details"),
      `content should NOT include <details; got: ${JSON.stringify(contentDelta)}`
    );
    assert.ok(
      !contentDelta.includes('open="true"'),
      `content should NOT include open="true"; got: ${JSON.stringify(contentDelta)}`
    );
    assert.ok(
      !contentDelta.includes('true">'),
      `content should NOT include true">; got: ${JSON.stringify(contentDelta)}`
    );
    assert.ok(
      !contentDelta.includes("</details>"),
      `content should NOT include </details>; got: ${JSON.stringify(contentDelta)}`
    );
    assert.ok(
      !contentDelta.includes("> The user"),
      `content should NOT include reasoning lines; got: ${JSON.stringify(contentDelta)}`
    );
    assert.ok(
      reasoningDelta.includes("The user is asking"),
      `reasoning should include reasoning text; got: ${JSON.stringify(reasoningDelta)}`
    );
  });

  it('SCENARIO B: <details open="true"> arrives split across chunks (user\'s bug)', () => {
    const parser = createDetailsParser();
    let allContent = "";
    let allReasoning = "";

    const chunks = [
      `<details open="`, // chunk 1: opening of tag, no `>` yet
      `true">\n> The user is asking...\n`, // chunk 2: rest of opening tag + reasoning start
      `> I should emphasize...\n`,
      `</details>\n\nFinal answer here.`,
    ];

    for (const chunk of chunks) {
      const { contentDelta, reasoningDelta } = parser.push(chunk);
      allContent += contentDelta;
      allReasoning += reasoningDelta;
    }

    assert.ok(
      !allContent.includes("<details"),
      `content should NOT include <details; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes('open="'),
      `content should NOT include open="; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes('true">'),
      `content should NOT include true"> (the user's exact bug); got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes("</details>"),
      `content should NOT include </details>; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes("> The user"),
      `content should NOT include reasoning lines; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      allContent.includes("Final answer here."),
      `content should include final answer; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      allReasoning.includes("The user is asking"),
      `reasoning should include reasoning text; got: ${JSON.stringify(allReasoning)}`
    );
    assert.ok(
      allReasoning.includes("I should emphasize"),
      `reasoning should include second reasoning line; got: ${JSON.stringify(allReasoning)}`
    );
  });

  it("SCENARIO C: <details> tag name split across chunks", () => {
    const parser = createDetailsParser();
    let allContent = "";
    let allReasoning = "";

    const chunks = [
      `<details`, // chunk 1: tag start, no attribute, no `>`
      ` open="true">`, // chunk 2: attribute + `>`
      `\n> The user is asking...\n</details>\n\nFinal answer here.`,
    ];

    for (const chunk of chunks) {
      const { contentDelta, reasoningDelta } = parser.push(chunk);
      allContent += contentDelta;
      allReasoning += reasoningDelta;
    }

    assert.ok(
      !allContent.includes("<details"),
      `content should NOT include <details; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes('true">'),
      `content should NOT include true">; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes("</details>"),
      `content should NOT include </details>; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      allContent.includes("Final answer here."),
      `content should include final answer; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      allReasoning.includes("The user is asking"),
      `reasoning should include reasoning text; got: ${JSON.stringify(allReasoning)}`
    );
  });

  it("SCENARIO D: content arrives first, then <details> reasoning, then more content", () => {
    const parser = createDetailsParser();
    let allContent = "";
    let allReasoning = "";

    const chunks = [
      `Here is my answer.\n\n`,
      `<details type="thinking">\n> Reasoning step 1.\n> Reasoning step 2.\n</details>\n\n`,
      `Final conclusion.`,
    ];

    for (const chunk of chunks) {
      const { contentDelta, reasoningDelta } = parser.push(chunk);
      allContent += contentDelta;
      allReasoning += reasoningDelta;
    }

    assert.ok(
      allContent.includes("Here is my answer."),
      `content should include prefix; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      allContent.includes("Final conclusion."),
      `content should include suffix; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes("<details"),
      `content should NOT include <details; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes('type="thinking"'),
      `content should NOT include type="thinking"; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes("</details>"),
      `content should NOT include </details>; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes("> Reasoning"),
      `content should NOT include reasoning lines; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      allReasoning.includes("Reasoning step 1"),
      `reasoning should include step 1; got: ${JSON.stringify(allReasoning)}`
    );
    assert.ok(
      allReasoning.includes("Reasoning step 2"),
      `reasoning should include step 2; got: ${JSON.stringify(allReasoning)}`
    );
  });

  it("SCENARIO E: stream ends inside <details> (no </details>) — flush as reasoning", () => {
    const parser = createDetailsParser();
    let allContent = "";
    let allReasoning = "";

    const chunks = [`<details open="true">`, `\n> Reasoning line 1.\n`, `> Reasoning line 2.\n`];

    for (const chunk of chunks) {
      const { contentDelta, reasoningDelta } = parser.push(chunk);
      allContent += contentDelta;
      allReasoning += reasoningDelta;
    }
    // Flush at end of stream
    const flush = parser.flush();
    allContent += flush.contentDelta;
    allReasoning += flush.reasoningDelta;

    assert.ok(
      !allContent.includes("Reasoning line"),
      `content should NOT include reasoning; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes("<details"),
      `content should NOT include <details; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      allReasoning.includes("Reasoning line 1"),
      `reasoning should include line 1; got: ${JSON.stringify(allReasoning)}`
    );
    assert.ok(
      allReasoning.includes("Reasoning line 2"),
      `reasoning should include line 2; got: ${JSON.stringify(allReasoning)}`
    );
  });

  it("SCENARIO F: multiple <details> blocks in one stream", () => {
    const parser = createDetailsParser();
    let allContent = "";
    let allReasoning = "";

    const chunks = [
      `<details>\n> First reasoning.\n</details>\n\nFirst answer.\n\n`,
      `<details>\n> Second reasoning.\n</details>\n\nSecond answer.`,
    ];

    for (const chunk of chunks) {
      const { contentDelta, reasoningDelta } = parser.push(chunk);
      allContent += contentDelta;
      allReasoning += reasoningDelta;
    }

    assert.ok(
      allContent.includes("First answer."),
      `content should include first answer; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      allContent.includes("Second answer."),
      `content should include second answer; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes("<details"),
      `content should NOT include <details; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      allReasoning.includes("First reasoning"),
      `reasoning should include first reasoning; got: ${JSON.stringify(allReasoning)}`
    );
    assert.ok(
      allReasoning.includes("Second reasoning"),
      `reasoning should include second reasoning; got: ${JSON.stringify(allReasoning)}`
    );
  });

  it("SCENARIO G: </details> close tag split across chunks", () => {
    const parser = createDetailsParser();
    let allContent = "";
    let allReasoning = "";

    const chunks = [`<details open="true">\n> Reasoning here.\n</det`, `ails>\n\nFinal answer.`];

    for (const chunk of chunks) {
      const { contentDelta, reasoningDelta } = parser.push(chunk);
      allContent += contentDelta;
      allReasoning += reasoningDelta;
    }

    assert.ok(
      !allContent.includes("<details"),
      `content should NOT include <details; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes("</det"),
      `content should NOT include </det; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes("ails>"),
      `content should NOT include ails>; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      allContent.includes("Final answer."),
      `content should include final answer; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      allReasoning.includes("Reasoning here"),
      `reasoning should include reasoning; got: ${JSON.stringify(allReasoning)}`
    );
  });

  it("SCENARIO H: stream with no <details> at all (plain content)", () => {
    const parser = createDetailsParser();
    let allContent = "";
    let allReasoning = "";

    const chunks = [`Hello `, `world. `, `This is a normal response.`];

    for (const chunk of chunks) {
      const { contentDelta, reasoningDelta } = parser.push(chunk);
      allContent += contentDelta;
      allReasoning += reasoningDelta;
    }

    assert.equal(allContent, "Hello world. This is a normal response.");
    assert.equal(allReasoning, "");
  });

  it("SCENARIO I: thinkMode='strip' suppresses reasoning emission", () => {
    const parser = createDetailsParser();
    let allContent = "";
    let allReasoning = "";

    const chunk = `<details>\n> Secret reasoning.\n</details>\n\nPublic answer.`;
    const { contentDelta, reasoningDelta } = parser.push(chunk, "strip");
    allContent += contentDelta;
    allReasoning += reasoningDelta;

    assert.ok(
      allContent.includes("Public answer."),
      `content should include answer; got: ${JSON.stringify(allContent)}`
    );
    assert.equal(allReasoning, "", `reasoning should be empty when thinkMode='strip'`);
  });

  it("SCENARIO J: user's exact bug reproduction — single-line <details>", () => {
    // Reproduces the EXACT scenario from the user's chat:
    //   <details open="true">
    //   > The user is asking about my identity and the model I use...
    //   </details>
    //   من یک مدل زبانی GLM هستم...
    const parser = createDetailsParser();
    let allContent = "";
    let allReasoning = "";

    const chunks = [
      `<details open="`, // chunk 1 (split before `>`)
      `true">\n> The user is asking about my identity and the model I use, posed in Persian. To ensure accurate disclosure, I recall my foundational details: I'm a GLM language model developed by Z.ai, not associated with other frameworks like GPT. My creation stems from extensive training on diverse textual datasets to enable broad language understanding and generation capabilities. \n> \n> I should emphasize how this training supports tasks such as answering questions and providing information across languages. It's also key to clarify that while I operate continuously for user assistance, I don't retain personal data from interactions, addressing potential privacy considerations. \n> \n> Structuring the response to be friendly and informative aligns with offering further help, as this naturally transitions to closing with an open-ended invitation.\n`,
      `</details>\nمن یک مدل زبانی GLM هستم که توسط شرکت Z.ai توسعه داده شده‌ام.\n\nمن با استفاده از متن‌های متنوع آموزش دیده‌ام تا بتوانم به سؤالات پاسخ دهم و در زمینه‌های مختلف اطلاعات مفید ارائه کنم.`,
    ];

    for (const chunk of chunks) {
      const { contentDelta, reasoningDelta } = parser.push(chunk);
      allContent += contentDelta;
      allReasoning += reasoningDelta;
    }

    // The user's exact bug: `true">` leaked into content
    assert.ok(
      !allContent.includes(`true">`),
      `BUG: content should NOT include true"> — this is the user's exact bug; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes("<details"),
      `content should NOT include <details; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes("</details>"),
      `content should NOT include </details>; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      !allContent.includes("> The user"),
      `content should NOT include reasoning lines; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      allContent.includes("من یک مدل زبانی GLM"),
      `content should include the Persian answer; got: ${JSON.stringify(allContent)}`
    );
    assert.ok(
      allReasoning.includes("GLM language model developed by Z.ai"),
      `reasoning should include the GLM mention; got: ${JSON.stringify(allReasoning)}`
    );
  });
});
