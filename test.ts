import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing. Add it to .env.");
  }

  const client = new GoogleGenerativeAI(apiKey);
  const model = client.getGenerativeModel({ model: "gemini-2.5-flash" });

  const result = await model.generateContent("Explain how AI works in a few words");
  const text = result.response.text();

  if (!text || !text.trim()) {
    console.log("Gemini returned an empty response.");
    return;
  }

  console.log("Gemini response:");
  console.log(text);
}

main().catch((error: unknown) => {
  console.error("Gemini request failed:");
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});