// __tests__/remediation.test.ts
import { fundWithFriendbot } from "../remediation";

describe("fundWithFriendbot", () => {
  afterEach(() => jest.restoreAllMocks());

  it("resolves on a 200 from friendbot", async () => {
    const fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: true } as Response);
    await expect(fundWithFriendbot("GABC")).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://friendbot.stellar.org?addr=GABC",
    );
  });

  it("throws a friendly error on non-OK (already funded)", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: false } as Response);
    await expect(fundWithFriendbot("GABC")).rejects.toThrow(/already be funded/i);
  });
});
