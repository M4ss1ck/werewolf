import { configure } from "@testing-library/dom";
import "@testing-library/jest-dom/vitest";

configure({ asyncUtilTimeout: 5_000 });
