import { PreferencesProvider } from "../components/preferences";
import "./appearance.css";
import type { Metadata } from "next";
import "./globals.css";
import "./tools.css";
import "./polish.css";
import { SharedWalletProvider } from "../components/shared-wallet";
import Ecosystem from "../components/ecosystem";

export const metadata: Metadata = {
  title: "RetiumP4y | Testnet Payments",
  description: "RetiumP4y is an independent community-built payments and DeFi workspace for the Retium testnet.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <PreferencesProvider>
          <SharedWalletProvider>
            <Ecosystem />
            {children}
          </SharedWalletProvider>
        </PreferencesProvider>
      </body>
    </html>
  );
}
