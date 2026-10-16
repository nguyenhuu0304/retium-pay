"use client";
import { CopyValue } from "./copy-value";
import { UiText } from "./preferences";
export type TelegramName = { displayName: string; username: string };
export function MemberIdentity({
  nickname,
  telegram,
  address,
}: {
  nickname?: string;
  telegram?: TelegramName;
  address: string;
}) {
  const name = telegram
    ? [telegram.displayName, telegram.username ? `@${telegram.username}` : ""]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    <span
      className="member-identity"
      style={{ minWidth: 0, display: "grid", gap: 5, overflowWrap: "anywhere" }}
    >
      <strong>{nickname || <UiText text="Unnamed payer" />}</strong>
      {name && <span style={{ fontSize: 12, opacity: 0.75 }}>{name}</span>}
      <span style={{ fontSize: 12 }}>
        <CopyValue value={address} compact />
      </span>
    </span>
  );
}
