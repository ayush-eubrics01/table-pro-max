import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConnectingDialog } from "./ConnectingDialog";
import { profile } from "../../test/fixtures";
import { useUi } from "../../stores/ui";

afterEach(() => {
  cleanup();
  useUi.setState({ confirmRequest: null, promptRequest: null });
});

describe("ConnectingDialog", () => {
  it("names the connection, its environment and target while connecting", () => {
    render(<ConnectingDialog profile={profile} />);
    expect(screen.getByRole("status")).toHaveTextContent(`Connecting to ${profile.name}`);
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText(/app@localhost:5432\/app/)).toBeInTheDocument();
  });

  it("steps aside while a password or host-trust prompt is open", () => {
    useUi.setState({ promptRequest: { title: "Password", label: "Password", initial: "", confirmLabel: "Connect", resolve: () => undefined } });
    const { container } = render(<ConnectingDialog profile={profile} />);
    expect(container).toBeEmptyDOMElement();
  });
});
