import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/AppShell";
import { getSuites } from "@/lib/notes";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "System Design Prep — Interview Course",
  description:
    "A hands-on system design interview course. Requirements, teardowns, cheat sheets, a 40-minute playbook, and level-based scoring for each classic problem.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <AppShell suites={getSuites()}>{children}</AppShell>
      </body>
    </html>
  );
}
