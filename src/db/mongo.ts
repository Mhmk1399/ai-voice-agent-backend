import mongoose from "mongoose";
import { env } from "../config/env.js";

let isConnected = false;

export async function connectMongo() {
  if (isConnected) return;

  await mongoose.connect(env.MONGODB_URI);

  isConnected = true;

  console.log("MongoDB connected:", mongoose.connection.name);
}