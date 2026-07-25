import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const quoteForShell = (value: string) => {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
};

const windowsPathToWsl = (windowsPath: string) => {
  const parsed = path.win32.parse(windowsPath);
  const drive = parsed.root.replace(/[:\\]/g, "").toLowerCase();
  const unixPath = windowsPath
    .replace(/^[A-Za-z]:\\/, "")
    .replace(/\\/g, "/");
  return `/mnt/${drive}/${unixPath}`;
};

export class OcrService {
  async ocrPdf(_absolutePdfPath: string): Promise<string> {
    const tmpOut = path.join(process.cwd(), "tmp_ocr_output.txt");

    const runOcrPdf = (command: string) => {
      execSync(command, { stdio: "ignore" });
      const txt = fs.readFileSync(tmpOut, "utf-8");
      fs.unlinkSync(tmpOut);
      return txt;
    };

    const tryNative = () => {
      try {
        execSync("which ocrmypdf", { stdio: "ignore" });
        return runOcrPdf(`ocrmypdf --sidecar ${quoteForShell(tmpOut)} ${quoteForShell(_absolutePdfPath)} /dev/null`);
      } catch {
        return null;
      }
    };

    const tryWindowsNative = () => {
      try {
        execSync("where ocrmypdf", { stdio: "ignore" });
        return runOcrPdf(`ocrmypdf --sidecar ${quoteForShell(tmpOut)} ${quoteForShell(_absolutePdfPath)} /dev/null`);
      } catch {
        return null;
      }
    };

    const tryWsl = () => {
      try {
        execSync("where wsl", { stdio: "ignore" });
        const wslPath = windowsPathToWsl(_absolutePdfPath);
        execSync(`wsl which ocrmypdf`, { stdio: "ignore" });
        return runOcrPdf(`wsl ocrmypdf --sidecar ${quoteForShell(tmpOut)} ${quoteForShell(wslPath)} /dev/null`);
      } catch {
        return null;
      }
    };

    if (process.platform === "win32") {
      const nativeResult = tryWindowsNative();
      if (nativeResult) {
        return nativeResult;
      }

      const wslResult = tryWsl();
      if (wslResult) {
        return wslResult;
      }
    } else {
      const nativeResult = tryNative();
      if (nativeResult) {
        return nativeResult;
      }
    }

    throw new Error(
      "OCR not available: install ocrmypdf and its dependencies. On Windows, either install the native tools or install WSL + a Linux distro and run `ocrmypdf` there."
    );
  }
}
