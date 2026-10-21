import { UiText } from "../components/preferences";
import { DashboardWallet } from "../components/shared-wallet";
import Link from "next/link";
const tools = [
  {title: "Lending", text: "Explore an isolated testnet lending market with RTM collateral.", href: "/lending", label: "Open Lending", number: "08"},
  {
    title: "Split Bill",
    text: "Split a group bill and send each payer a Telegram payment request.",
    href: "/split",
    label: "Create split bill",
    number: "07",
  },
  {
    title: "Telegram",
    text: "Link your wallet to receive payment and transaction updates.",
    href: "/telegram",
    label: "Link Telegram",
    number: "01",
  },
  {
    title: "Payments",
    text: "Create an RTM payment request or open a request to pay.",
    href: "/payments",
    label: "Open payments",
    number: "02",
  },
  {
    title: "My History",
    text: "View requests you created and payments addressed to you.",
    href: "/requests",
    label: "View history",
    number: "03",
  },
  {
    title: "Swap & liquidity",
    text: "Swap tokens, create pools and manage liquidity in Retium Pay.",
    href: "/dex",
    label: "Open DEX",
    number: "04",
  },
  {
    title: "Deploy token",
    text: "Create a fungible test token and track its deployment.",
    href: "/deploy",
    label: "Deploy a token",
    number: "05",
  },
  {
    title: "Retium Pay Explorer",
    text: "Look up public transactions, wallets and contracts.",
    href: "/explorer",
    label: "Open Explorer",
    number: "06",
  },
];
export default function Home() {
  return (
    <main className="pay-dashboard">
      <header className="dashboard-heading">
        <div>
          <p className="eyebrow">
            {<UiText text={"RETIUM PAY · TESTNET"} />}
          </p>
          <h1>{<UiText text={"Your Retium workspace."} />}</h1>
          <p>
            {
              <UiText
                text={
                  "Payments, Telegram updates and on-chain tools in one place."
                }
              />
            }
          </p>
        </div>
        <span className="network-pill">{<UiText text={"Testnet"} />}</span>
      </header>
      <DashboardWallet />
      <section className="dashboard-start">
        <div>
          <span className="tag">{<UiText text={"Start here"} />}</span>
          <h2>{<UiText text={"Keep your updates in Telegram."} />}</h2>
          <p>
            {
              <UiText
                text={
                  "Link your wallet once to receive notifications from Retium Pay."
                }
              />
            }
          </p>
        </div>
        <Link className="button primary" href="/telegram">
          {<UiText text={"Set up Telegram →"} />}
        </Link>
      </section>
      <section className="dashboard-tools" aria-label="Available tools">
        {[...tools].filter((item) => item.href !== "/telegram").sort((a, b) => ["/payments", "/split", "/requests", "/dex", "/deploy", "/explorer", "/lending"].indexOf(a.href) - ["/payments", "/split", "/requests", "/dex", "/deploy", "/explorer", "/lending"].indexOf(b.href)).map((item) => (
          <article className="dashboard-tool" key={item.href}>
            <h2>{<UiText text={item.title} />}</h2>
            <p>{<UiText text={item.text} />}</p>
            <Link className="button secondary" href={item.href}>
              {<UiText text={item.label} />} →
            </Link>
          </article>
        ))}
      </section>

      <footer className="dashboard-footer">
        {
          <UiText
            text={
              "Independent community project · Testnet assets have no real-world value."
            }
          />
        }
      </footer>
    </main>
  );
}

