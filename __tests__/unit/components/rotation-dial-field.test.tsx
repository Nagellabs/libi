// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { RotationDialField } from "@/components/preview/rotation-dial-field";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";
import type { Transform3D } from "@/lib/engine/types";

function renderDial(
  props: Partial<React.ComponentProps<typeof RotationDialField>> = {},
) {
  const onChange = props.onChange ?? vi.fn();
  const onFlush = props.onFlush ?? vi.fn();
  render(
    <RotationDialField
      transform3d={props.transform3d ?? IDENTITY_TRANSFORM3D}
      locked={props.locked}
      onChange={onChange}
      onFlush={onFlush}
    />,
  );
  return { onChange, onFlush };
}

describe("RotationDialField", () => {
  it("renders the two out-of-plane ring dials + two editable degree inputs (Spin removed)", () => {
    renderDial();
    expect(screen.getByTestId("rotation-dial-field")).toBeInTheDocument();
    expect(screen.getByTestId("gizmo-ring-angle")).toBeInTheDocument();
    expect(screen.getByTestId("gizmo-ring-elevation")).toBeInTheDocument();
    expect(screen.getByTestId("rotation-input-y")).toBeInTheDocument();
    expect(screen.getByTestId("rotation-input-x")).toBeInTheDocument();
    // Spin (rotation.z) is gone from the dial — scene-root roll doesn't render,
    // so in-plane roll is owned by the 2D rotation/transformSpin control instead.
    expect(screen.queryByTestId("gizmo-ring-spin")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rotation-input-z")).not.toBeInTheDocument();
  });

  it("reflects the current rotation as degrees in the inputs", () => {
    const t: Transform3D = {
      ...IDENTITY_TRANSFORM3D,
      rotation: { x: 0, y: Math.PI / 2, z: 0 },
    };
    renderDial({ transform3d: t });
    expect((screen.getByTestId("rotation-input-y") as HTMLInputElement).value).toBe("90");
  });

  it("typing a degree value emits the matching radian rotation; blur flushes", () => {
    const onChange = vi.fn();
    const onFlush = vi.fn();
    renderDial({ onChange, onFlush });
    const elev = screen.getByTestId("rotation-input-x") as HTMLInputElement;
    fireEvent.change(elev, { target: { value: "45" } });
    expect(onChange).toHaveBeenCalled();
    const arg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(arg.rotation.x).toBeCloseTo(Math.PI / 4, 4);
    expect(arg.rotation.y).toBe(0);
    fireEvent.blur(elev);
    expect(onFlush).toHaveBeenCalled();
  });

  it("dragging the elevation ring emits a non-zero x rotation, flushing on release", () => {
    const onChange = vi.fn();
    const onFlush = vi.fn();
    renderDial({ onChange, onFlush });
    fireEvent.mouseDown(screen.getByTestId("gizmo-ring-elevation"), { clientX: 10, clientY: 10 });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, clientY: 200 }));
    window.dispatchEvent(new MouseEvent("mouseup", {}));
    expect(onChange).toHaveBeenCalled();
    const arg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(Number.isFinite(arg.rotation.x)).toBe(true);
    expect(arg.rotation.x).not.toBe(0);
    expect(onFlush).toHaveBeenCalled();
  });

  it("locked: inputs are disabled and a ring drag never emits", () => {
    const onChange = vi.fn();
    renderDial({ locked: true, onChange });
    expect((screen.getByTestId("rotation-input-x") as HTMLInputElement).disabled).toBe(true);
    fireEvent.mouseDown(screen.getByTestId("gizmo-ring-elevation"), { clientX: 10, clientY: 10 });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 200, clientY: 200 }));
    window.dispatchEvent(new MouseEvent("mouseup", {}));
    expect(onChange).not.toHaveBeenCalled();
  });
});
