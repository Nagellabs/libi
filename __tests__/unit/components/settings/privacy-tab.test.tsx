// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { PrivacyTab } from "@/components/settings/privacy-tab";

// Same mocking pattern as __tests__/unit/components/settings/mcp-server-card.test.tsx:
// stub the React Query hooks the component reads from so it renders in isolation,
// without a real QueryClientProvider or network calls.
const analyticsMutate = vi.fn();
const crashReportMutate = vi.fn();

// Per-test query state. Both hooks are mocked as mutable holders so a single
// test can put ONE query into loading/error while the other stays healthy —
// that independence is the whole point of the split loading states.
let analyticsState: { data?: { enabled: boolean }; isLoading: boolean; isError: boolean } = {
  data: { enabled: true },
  isLoading: false,
  isError: false,
};
// Mutation error state is per-toggle too: the load-error condition (a degraded
// settings DB) is the same one that makes the PUT fail, so the save failure has
// to be surfaced independently of the read failure.
let analyticsMutationError = false;
let crashReportMutationError = false;

vi.mock("@/lib/queries/analytics-settings", () => ({
  useAnalyticsSettings: () => analyticsState,
  useSetAnalyticsEnabled: () => ({ mutate: analyticsMutate, isError: analyticsMutationError }),
}));

let crashReportChoice: "unset" | "on" | "off" = "unset";
let crashReportState: { isLoading: boolean; isError: boolean } = {
  isLoading: false,
  isError: false,
};
vi.mock("@/lib/queries/crash-report-settings", () => ({
  useCrashReportSettings: () => ({
    // On error there is no data — the component must still render an operable
    // switch, so this mirrors the real hook rather than always supplying data.
    data: crashReportState.isError
      ? undefined
      : { choice: crashReportChoice, decidedAt: null },
    isLoading: crashReportState.isLoading,
    isError: crashReportState.isError,
  }),
  useSetCrashReportsEnabled: () => ({
    mutate: crashReportMutate,
    isError: crashReportMutationError,
  }),
}));

vi.mock("@/lib/analytics/client", () => ({
  setClientAnalyticsEnabled: vi.fn(),
  trackEvent: vi.fn(),
}));

const crashToggle = () => screen.getByRole("switch", { name: /send crash reports/i });
const analyticsToggle = () =>
  screen.getByRole("switch", { name: /share anonymous usage analytics/i });

beforeEach(() => {
  analyticsMutate.mockClear();
  crashReportMutate.mockClear();
  crashReportChoice = "unset";
  analyticsState = { data: { enabled: true }, isLoading: false, isError: false };
  crashReportState = { isLoading: false, isError: false };
  analyticsMutationError = false;
  crashReportMutationError = false;
});

describe("PrivacyTab — crash-report toggle", () => {
  it("renders ON for the default 'unset' choice (not asked yet ⇒ still reporting)", () => {
    crashReportChoice = "unset";
    render(<PrivacyTab />);
    expect(crashToggle()).toBeChecked();
  });

  it("renders ON for an explicit 'on' choice", () => {
    crashReportChoice = "on";
    render(<PrivacyTab />);
    expect(crashToggle()).toBeChecked();
  });

  it("renders OFF for an explicit 'off' choice", () => {
    crashReportChoice = "off";
    render(<PrivacyTab />);
    expect(crashToggle()).not.toBeChecked();
  });

  it("calls the mutation directly on toggle-off — no confirmation dialog", () => {
    crashReportChoice = "on";
    render(<PrivacyTab />);

    fireEvent.click(crashToggle());

    // Unlike the analytics toggle (which opens an AlertDialog and requires a
    // second click on "Turn off"), the crash-report toggle must call the
    // mutation immediately: objecting to this processing is a right, and a
    // confirmation step is exactly the friction that must not exist here.
    expect(crashReportMutate).toHaveBeenCalledTimes(1);
    expect(crashReportMutate).toHaveBeenCalledWith(false);
    expect(
      screen.queryByText(/turn off (crash reports|usage analytics)\?/i),
    ).not.toBeInTheDocument();
  });

  it("calls the mutation directly on toggle-on", () => {
    crashReportChoice = "off";
    render(<PrivacyTab />);

    fireEvent.click(crashToggle());

    expect(crashReportMutate).toHaveBeenCalledTimes(1);
    expect(crashReportMutate).toHaveBeenCalledWith(true);
  });

  it("does not render the retired 'no switch yet' interim notice", () => {
    render(<PrivacyTab />);
    expect(screen.queryByText(/LIBI_SENTRY_DISABLED/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no switch for this yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/a toggle is coming/i)).not.toBeInTheDocument();
  });

  it("describes the scrubber honestly — paths are rewritten, not dropped", () => {
    render(<PrivacyTab />);
    // The policy one click away says the surrounding path structure can still
    // be revealing, so this copy must not claim file paths are "stripped".
    expect(screen.queryByText(/file paths and your\s+OS user name are stripped/i)).toBeNull();
    expect(
      screen.getByText(/removed from the file paths in them/i),
    ).toBeInTheDocument();
  });
});

describe("PrivacyTab — a failed SAVE is surfaced, and the load error promises nothing", () => {
  const saveError = () => screen.queryAllByText(/couldn't save your choice/i);

  it("says so when the crash-report mutation fails", () => {
    crashReportMutationError = true;
    render(<PrivacyTab />);
    // Without this the switch just snaps back to the server value in silence,
    // and a user who believes they opted out is wrong.
    expect(saveError()).toHaveLength(1);
  });

  it("says so when the analytics mutation fails", () => {
    analyticsMutationError = true;
    render(<PrivacyTab />);
    expect(saveError()).toHaveLength(1);
  });

  it("shows nothing when both mutations are healthy", () => {
    render(<PrivacyTab />);
    expect(saveError()).toHaveLength(0);
  });

  it("does not promise the change will be saved when the read failed", () => {
    crashReportState = { isLoading: false, isError: true };
    analyticsState = { data: undefined, isLoading: false, isError: true };
    render(<PrivacyTab />);

    // The load error fires exactly when the settings DB is degraded — the same
    // condition that makes the PUT fail — so "changing it will still be saved"
    // was a false guarantee about exercising a right, made when it was least
    // likely to hold.
    expect(screen.queryByText(/will still be saved/i)).toBeNull();
    expect(screen.getAllByText(/couldn't load your current setting/i)).toHaveLength(2);
  });
});

describe("PrivacyTab — analytics toggle keeps its confirmation dialog", () => {
  it("opens the AlertDialog on toggle-off instead of mutating immediately", () => {
    analyticsState = { data: { enabled: true }, isLoading: false, isError: false };
    render(<PrivacyTab />);

    fireEvent.click(analyticsToggle());

    // POSITIVE assertion: the analytics opt-out is a deliberate "are you sure?"
    // (unlike crash reports). Asserting only the dialog's ABSENCE after a
    // crash-toggle click would let a silently-broken analytics confirmation
    // through.
    expect(screen.getByText(/turn off usage analytics\?/i)).toBeInTheDocument();
    expect(analyticsMutate).not.toHaveBeenCalled();

    // …and confirming inside the dialog is what actually mutates.
    fireEvent.click(screen.getByRole("button", { name: /^turn off$/i }));
    expect(analyticsMutate).toHaveBeenCalledWith(false);
  });

  it("mutates immediately when turning analytics back ON (no dialog to re-opt-in)", () => {
    analyticsState = { data: { enabled: false }, isLoading: false, isError: false };
    render(<PrivacyTab />);

    fireEvent.click(analyticsToggle());

    expect(analyticsMutate).toHaveBeenCalledWith(true);
    expect(screen.queryByText(/turn off usage analytics\?/i)).not.toBeInTheDocument();
  });
});

describe("PrivacyTab — one failing/loading query must not brick the other toggle", () => {
  it("keeps the analytics toggle operable when the crash-report query errors", () => {
    analyticsState = { data: { enabled: true }, isLoading: false, isError: false };
    crashReportState = { isLoading: false, isError: true };
    render(<PrivacyTab />);

    // Regression guard: these two used to be AND-coupled into a single
    // skeleton, so on ERROR (isLoading false AND data undefined) the whole tab
    // rendered a permanent skeleton and NEITHER opt-out could be exercised.
    fireEvent.click(analyticsToggle());
    expect(screen.getByText(/turn off usage analytics\?/i)).toBeInTheDocument();
  });

  it("keeps the crash-report toggle operable (against the default) when its query errors", () => {
    crashReportState = { isLoading: false, isError: true };
    render(<PrivacyTab />);

    const toggle = crashToggle();
    expect(toggle).toBeChecked(); // shipped default: reporting on
    fireEvent.click(toggle);
    expect(crashReportMutate).toHaveBeenCalledWith(false);
  });

  it("keeps the crash-report toggle operable when only the ANALYTICS query is loading", () => {
    analyticsState = { data: undefined, isLoading: true, isError: false };
    crashReportChoice = "on";
    render(<PrivacyTab />);

    expect(screen.queryByRole("switch", { name: /share anonymous usage analytics/i })).toBeNull();
    fireEvent.click(crashToggle());
    expect(crashReportMutate).toHaveBeenCalledWith(false);
  });

  it("keeps the analytics toggle operable when only the CRASH-REPORT query is loading", () => {
    crashReportState = { isLoading: true, isError: false };
    render(<PrivacyTab />);

    expect(screen.queryByRole("switch", { name: /send crash reports/i })).toBeNull();
    fireEvent.click(analyticsToggle());
    expect(screen.getByText(/turn off usage analytics\?/i)).toBeInTheDocument();
  });
});
