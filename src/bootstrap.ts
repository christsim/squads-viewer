// This file MUST be the entry point.
// It sets up Buffer globally before any @solana/web3.js code runs.
import { Buffer } from "buffer";

(window as any).global = window;
(window as any).process = { env: {} };
(window as any).Buffer = Buffer;

// Now dynamically import the app after globals are set
import("./main");
