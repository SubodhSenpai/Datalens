import { SITE_URL, SITE_NAME, SITE_DESCRIPTION, REPO_URL } from "@/lib/site";

// JSON-LD for search and answer engines: what the site is and what it does.
// No FAQPage node: rich results require the answers to be visible on the
// page, and the landing page is deliberately text-light.
export default function StructuredData() {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        url: SITE_URL,
        name: SITE_NAME,
        description: SITE_DESCRIPTION,
        inLanguage: "en",
      },
      {
        "@type": ["SoftwareApplication", "WebApplication"],
        "@id": `${SITE_URL}/#app`,
        name: SITE_NAME,
        url: SITE_URL,
        description: SITE_DESCRIPTION,
        applicationCategory: "BusinessApplication",
        applicationSubCategory: "Data analysis",
        operatingSystem: "Web browser",
        browserRequirements: "Requires JavaScript",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        license: "https://opensource.org/license/mit",
        codeRepository: REPO_URL,
        image: `${SITE_URL}/opengraph-image`,
        featureList: [
          "Ask questions about CSV and Excel files in plain English",
          "Charts and tables computed deterministically, not by the model",
          "Cross-file questions with automatic key detection",
          "Cleans formatted numbers, mixed dates, placeholders and TOTAL rows",
          "Free open-source models via OpenRouter or Google Gemini",
          "Full query plan and trace shown with every answer",
        ],
      },
    ],
  };
  return (
    <script
      type="application/ld+json"
      // "<" escaped so no value can ever close the script tag.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph).replace(/</g, "\\u003c") }}
    />
  );
}
