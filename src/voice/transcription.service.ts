import fs from "node:fs";
import { openai } from "../ai/openai.client.js";

export async function transcribeAudioFile(filePath: string) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "gpt-4o-mini-transcribe",
  });

  return transcription.text;
}