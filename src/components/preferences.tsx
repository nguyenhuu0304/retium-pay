"use client";
import { createContext, useContext, useEffect, useState } from "react";
import vi from "../lib/ui/vi.json";
type Language = "en" | "vi";
type Theme = "dark" | "light";
const dictionary: Record<string, string> = vi;
export function translateUi(text: string, language: Language) {
  if (language === "en") return text;
  const value = text.trim();
  const translated = dictionary[value];
  if (translated)
    return (
      text.slice(0, text.length - text.trimStart().length) +
      translated +
      text.slice(text.trimEnd().length)
    );
  return text;
}
const Context = createContext<{
  language: Language;
  theme: Theme;
  setLanguage: (x: Language) => void;
  setTheme: (x: Theme) => void;
}>({
  language: "en",
  theme: "dark",
  setLanguage: () => {},
  setTheme: () => {},
});
export function PreferencesProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [language, setLanguage] = useState<Language>("en"),
    [theme, setTheme] = useState<Theme>("dark"),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => {
      if (!live) return;
      try {
        const saved = JSON.parse(
          localStorage.getItem("retium-pay:preferences:v1") || "{}",
        );
        if (saved.language === "vi") setLanguage("vi");
        if (saved.theme === "light") setTheme("light");
      } catch {}
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    if (loaded)
      try {
        localStorage.setItem(
          "retium-pay:preferences:v1",
          JSON.stringify({ language, theme }),
        );
      } catch {}
  }, [language, theme, loaded]);
  return (
    <Context.Provider value={{ language, theme, setLanguage, setTheme }}>
      {children}
    </Context.Provider>
  );
}
export function UiText({ text }: { text: unknown }) {
  const { language } = useContext(Context);
  return typeof text === "string"
    ? translateUi(text, language)
    : typeof text === "number"
      ? text
      : null;
}
export function UiInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { language } = useContext(Context);
  return (
    <input
      {...props}
      placeholder={
        props.placeholder ? translateUi(props.placeholder, language) : undefined
      }
      aria-label={
        props["aria-label"]
          ? translateUi(props["aria-label"], language)
          : undefined
      }
    />
  );
}
export function PreferencesControls() {
  const { language, theme, setLanguage, setTheme } = useContext(Context);
  return (
    <div className="preferences-controls">
      <label className="visually-hidden" htmlFor="app-language">
        {language === "vi" ? "Ngôn ngữ" : "Language"}
      </label>
      <select
        id="app-language"
        value={language}
        onChange={(e) => setLanguage(e.target.value as Language)}
      >
        <option value="en">EN</option>
        <option value="vi">VI</option>
      </select>
      <button
        type="button"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        aria-label={
          language === "vi"
            ? "Chuyển chế độ sáng tối"
            : "Toggle light and dark theme"
        }
      >
        {theme === "dark"
          ? language === "vi"
            ? "☀ Sáng"
            : "☀ Light"
          : language === "vi"
            ? "☾ Tối"
            : "☾ Dark"}
      </button>
    </div>
  );
}
