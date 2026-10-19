"use client";
import { UiText, PreferencesControls } from "./preferences";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { WalletIndicator } from "./shared-wallet";
import Link from "next/link";
const websites = [
  ["Web Wallet", "https://wallet.retium.org/"],
  ["Retium Explorer", "https://retium.net/"],
  ["NFT", "https://nft.retium.org/"],
  ["Retium Money", "https://retium.money/"],
  ["Retium", "https://retium.org/"],
  ["SDK", "https://github.com/Retium-Org/retium-sdk"],
];
export default function Ecosystem() {
  const pathname = usePathname();
  const links = [["/payments", "Payments"], ["/split", "Split Bill"], ["/requests", "My History"], ["/dex", "DEX"]];
  const more = [["/telegram", "Telegram"], ["/deploy", "Deploy token"], ["/explorer", "Explorer"]];
  useEffect(() => {
    // Close native dropdowns on route changes, including Back/Forward navigation.
    document.querySelectorAll<HTMLDetailsElement>(".ecosystem-nav details[open]").forEach((node) => node.open = false);
  }, [pathname]);
  return (
    <nav className="ecosystem-nav" aria-label="Retium apps">
      <Link href="/" className="app-brand" aria-label="Retium Pay dashboard">
        Retium<span>Pay</span>
      </Link>
      {links.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          aria-current={pathname === href ? "page" : undefined}
        >
          {<UiText text={label} />}
        </Link>
      ))}
      <details className="more-menu">
        <summary><UiText text="More" /> <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="m3 4 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></summary>
        <div>{more.map(([href, label]) => <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}><UiText text={label} /></Link>)}</div>
      </details>
      <WalletIndicator />
      <PreferencesControls />
      <details>
        <summary><UiText text="Ecosystem" /> <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="m3 4 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></summary>
        <div>
          {websites.map(([name, url]) => (
            <a key={url} href={url} target="_blank" rel="noopener noreferrer">
              <UiText text={name} /> ↗
            </a>
          ))}
        </div>
      </details>
    </nav>
  );
}
