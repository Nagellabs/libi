export interface RenderDriver {
  name: "electron" | "playwright";
  runJob(input: {
    jobId: string;
    port: number;
  }): Promise<void>;
  /**
   * Optional: resolve the driver's active render mode — whether Chromium is
   * drawing through a real GPU or a software rasterizer. The runner uses this
   * to decide whether chunked parallel rendering pays off (software = one
   * renderer PROCESS per page → real multi-core win; GPU = the pages
   * time-slice one GPU/encoder → chunking is ~free). A driver that omits this
   * (the Electron driver — always a real GPU) is treated as `"gpu"`.
   */
  renderMode?(): Promise<"gpu" | "software">;
  shutdown(): Promise<void>;
}
