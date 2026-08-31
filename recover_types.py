
import json
import sys

file = r"C:\Users\hp\.gemini\antigravity-ide\brain\f2364f67-028e-4370-aa9c-a27f90a88d81\.system_generated\logs\transcript_full.jsonl"
with open(file, "r", encoding="utf-8") as f:
    for line in f:
        try:
            data = json.loads(line)
            content = data.get("content", "")
            if "types/index.ts" in content:
                print("CONTENT MATCH:")
                print(content[:1000])
                print("---")
            if "tool_calls" in data:
                for tc in data["tool_calls"]:
                    args = tc.get("function", {}).get("arguments", "")
                    if "types/index.ts" in args:
                        print("TOOL CALL MATCH:")
                        print(args[:1000])
                        print("---")
        except Exception:
            pass

