// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MusicLinks } from "@/components/templates/template-details/music-links";

it("names the song, says it is not included, and links its source by host", () => {
  render(<MusicLinks rows={[{ ref: "e", label: "Espresso — Sabrina Carpenter", source: { url: "https://www.youtube.com/watch?v=abc", host: "www.youtube.com" } }]} />);
  expect(screen.getByTestId("template-music-link")).toHaveTextContent("Music: Espresso — Sabrina Carpenter · not included");
  const a = screen.getByTestId("template-music-source");
  expect(a).toHaveAttribute("href", "https://www.youtube.com/watch?v=abc");
  expect(a).toHaveAttribute("rel", "noopener noreferrer");
  expect(a).toHaveTextContent("www.youtube.com");
});

it("isolates the author's label's direction and marks the source link as leaving libi", () => {
  render(<MusicLinks rows={[{ ref: "e", label: "שיר — Artist", source: { url: "https://www.youtube.com/watch?v=abc", host: "www.youtube.com" } }]} />);
  const row = screen.getByTestId("template-music-link");
  expect(row.querySelector("bdi")).toHaveTextContent("שיר — Artist");
  const a = screen.getByTestId("template-music-source");
  expect(a.querySelector("[data-testid='opens-outside-icon']")).not.toBeNull();
  expect(a).toHaveTextContent("(opens in your browser)");
  expect(a).not.toHaveTextContent("↗");
});
