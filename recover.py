
import json
import sys

file = r"C:\Users\hp\.gemini\antigravity-ide\brain\c8df1840-08b6-4711-b73a-60b249ab6b86\.system_generated\logs\transcript_full.jsonl"
with open(file, "r", encoding="utf-8") as f:
    for line in f:
        try:
            data = json.loads(line)
            if data.get("type") == "TOOL_RESPONSE":
                content = data.get("content", "")
                if "PurchasingPage.tsx" in content and "Total Lines:" in content:
                    lines = content.split("\n")
                    code_lines = []
                    start = False
                    for l in lines:
                        if start:
                            if l.startswith("The above content shows") or not ":" in l[:10]:
                                continue
                            if ":" in l:
                                code_lines.append(l.split(":", 1)[1].lstrip(" "))
                        if "The following code has been modified" in l:
                            start = True
                    if len(code_lines) > 500:
                        with open("src/components/purchasing/PurchasingPage.tsx", "w", encoding="utf-8") as out:
                            out.write("\n".join(code_lines))
                        print(f"Recovered PurchasingPage.tsx ({len(code_lines)} lines)")
                        sys.exit(0)
        except Exception:
            pass

