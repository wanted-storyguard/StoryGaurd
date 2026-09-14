import { useId } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { isThemePreference } from "../lib/theme";
import { useTheme } from "./ThemeProvider";

export function ThemePicker({ detailed = false }: { detailed?: boolean }) {
  const { preference, resolved, saved, setPreference } = useTheme();
  const id = useId();
  const Icon = preference === "system" ? Monitor : preference === "dark" ? Moon : Sun;
  return <div className={`theme-picker${detailed ? " theme-picker-detailed" : ""}`}>
    <label htmlFor={id}><Icon size={18} aria-hidden="true"/><span className={detailed ? undefined : "sr-only"}>화면 테마</span></label>
    <select id={id} value={preference} onChange={event => {
      if (isThemePreference(event.target.value)) setPreference(event.target.value);
    }}>
      <option value="system">시스템</option>
      <option value="light">라이트</option>
      <option value="dark">다크</option>
    </select>
    {detailed && <p>현재 {resolved === "dark" ? "다크" : "라이트"} 모드입니다. 시스템을 선택하면 기기의 화면 설정을 따릅니다.</p>}
    {!saved && <small role="status">이 창에 적용했어요. 테마 설정을 저장할 수 없어 다시 열면 초기화됩니다.</small>}
  </div>;
}
