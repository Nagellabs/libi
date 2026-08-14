import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import { toWebReadable } from "@/lib/http/streams";

describe("toWebReadable", () => {
  it("streams data through to the web ReadableStream", async () => {
    const node = Readable.from([Buffer.from("hello"), Buffer.from(" world")]);
    const web = toWebReadable(node);
    const reader = web.getReader();
    const out: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(Buffer.from(value).toString("utf-8"));
    }
    expect(out.join("")).toBe("hello world");
  });

  it("destroys source on cancel and never throws", async () => {
    let destroyed = false;
    const node = new Readable({
      read() { this.push(Buffer.from("chunk")); },
    });
    node.on("close", () => { destroyed = true; });

    const web = toWebReadable(node);
    const reader = web.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(destroyed).toBe(true);
  });

  it("swallows post-close enqueue errors (no uncaught)", async () => {
    let errored = false;
    const onErr = () => { errored = true; };
    process.once("uncaughtException", onErr);

    const node = new Readable({ read() {} });
    const web = toWebReadable(node);
    const reader = web.getReader();
    await reader.cancel();
    // After cancel, push more data — the wrapper should ignore the post-close enqueue.
    node.push(Buffer.from("late chunk"));
    node.push(null);
    await new Promise((r) => setTimeout(r, 20));

    process.off("uncaughtException", onErr);
    expect(errored).toBe(false);
  });
});
