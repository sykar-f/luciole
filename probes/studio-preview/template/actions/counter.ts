"use server";
import { z } from "zod";
import { add } from "../server/store";

const MAX_STEP = 10;
const Step = z.number().int().min(1).max(MAX_STEP);
export async function increment(step: number) {
  return add(Step.parse(step));
}
