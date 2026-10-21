import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Lending | Retium Pay",
  description: "Isolated testnet lending market with RTM collateral.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
