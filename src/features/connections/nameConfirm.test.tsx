import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Overlays } from "../../components/Overlays";
import { BackendError } from "../../lib/ipc";
import { session } from "../../test/fixtures";
import { withNameConfirm } from "./nameConfirm";

afterEach(cleanup);

const typedError = new BackendError({ kind: "confirmation_required", message: "Confirm execution on Local PG", code: "confirm_typed", detail: "DROP permanently removes objects: drop table t" });

describe("withNameConfirm", () => {
  it("asks for the connection name and retries with it", async () => {
    render(<Overlays />);
    const tries: (string | undefined)[] = [];
    const done = withNameConfirm(session, async (typed) => {
      tries.push(typed);
      if (!typed) throw typedError;
      return "dropped";
    });
    expect(await screen.findByText(/drop table t/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Run anyway" });
    const input = screen.getByLabelText("Type Local PG to confirm");
    expect(button).toBeDisabled();
    fireEvent.change(input, { target: { value: "local pg" } });
    expect(button).toBeDisabled();
    fireEvent.change(input, { target: { value: "Local PG" } });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(await done).toBe("dropped");
    expect(tries).toEqual([undefined, "Local PG"]);
  });

  it("gives up when the dialog is cancelled, and passes other errors on", async () => {
    render(<Overlays />);
    const cancelled = withNameConfirm(session, async () => {
      throw typedError;
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await cancelled).toBeNull();
    const other = new BackendError({ kind: "database", message: "boom" });
    await expect(
      withNameConfirm(session, async () => {
        throw other;
      }),
    ).rejects.toBe(other);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
