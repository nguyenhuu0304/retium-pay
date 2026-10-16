"use client";
import { UiText, PreferencesControls } from "./preferences";

import { usePathname } from "next/navigation";
import { WalletIndicator } from "./shared-wallet";
import Link from "next/link";
const websites = [
  ["Web Wallet", "https://wallet.retium.org/"],
  ["Explorer", "https://retium.net/"],
  ["NFT", "https://nft.retium.org/"],
  ["Retium Money", "https://retium.money/"],
  ["Retium", "https://retium.org/"],
  ["SDK", "https://github.com/Retium-Org/retium-sdk"],
];
export default function Ecosystem() {
  const pathname = usePathname();
  const links = [
    ["/telegram", "Telegram"],
    ["/payments", "Payments"],
    ["/split", "Split Bill"],
    ["/requests", "My History"],
    ["/dex", "DEX"],
    ["/deploy", "Deploy token"],
    ["/explorer", "Explorer"],
  ];
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
      <WalletIndicator />
      <PreferencesControls />
      <details>
        <summary>{<UiText text={"Retium Ecosystem ↗"} />}</summary>
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
