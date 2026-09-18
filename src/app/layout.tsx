import type { Metadata } from "next";
import { Baloo_2, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const baloo = Baloo_2({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--font-baloo" });
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-jakarta" });

export const metadata: Metadata = {
  title: "DataLens",
  description: "Upload CSV or Excel files, ask questions in plain English, get charts.",
  keywords: ["data analysis", "AI", "CSV", "Excel", "natural language query", "charts"],
  openGraph: {
    title: "DataLens",
    description: "Ask your files anything.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${baloo.variable} ${jakarta.variable}`}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#F3EEE0" />
      </head>
      <body>{children}</body>
    </html>
  );
}
