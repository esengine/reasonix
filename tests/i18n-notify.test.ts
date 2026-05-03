import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLanguage,
  notifyLanguageChange,
  onLanguageChange,
  setLanguageRuntime,
  t,
} from "../src/i18n/index.js";

describe("i18n language change notifications", () => {
  afterEach(() => {
    setLanguageRuntime("EN");
  });

  it("fires listener when notifyLanguageChange is called", () => {
    const cb = vi.fn();
    const unsub = onLanguageChange(cb);
    notifyLanguageChange();
    expect(cb).toHaveBeenCalledOnce();
    unsub();
  });

  it("supports multiple listeners", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = onLanguageChange(cb1);
    const unsub2 = onLanguageChange(cb2);
    notifyLanguageChange();
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
    unsub1();
    unsub2();
  });

  it("unsubscribes correctly", () => {
    const cb = vi.fn();
    const unsub = onLanguageChange(cb);
    unsub();
    notifyLanguageChange();
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not interfere with other listeners when one unsubscribes", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = onLanguageChange(cb1);
    onLanguageChange(cb2);
    unsub1();
    notifyLanguageChange();
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it("t() returns new language strings after setLanguageRuntime + notify", () => {
    setLanguageRuntime("zh-CN");
    expect(t("slash.language.success")).toBe("语言已切换为简体中文。");
    setLanguageRuntime("EN");
    expect(t("slash.language.success")).toBe("Language switched to English.");
  });

  it("getLanguage reflects the current language", () => {
    expect(getLanguage()).toBe("EN");
    setLanguageRuntime("zh-CN");
    expect(getLanguage()).toBe("zh-CN");
    setLanguageRuntime("EN");
  });
});
