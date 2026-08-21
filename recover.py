
import json

transcript_path = r"C:\Users\hp\.gemini\antigravity-ide\brain\c8df1840-08b6-4711-b73a-60b249ab6b86\.system_generated\logs\transcript_full.jsonl"

with open(transcript_path, "r", encoding="utf-8") as f:
    for line in f:
        try:
            data = json.loads(line)
            if data.get("type") == "TOOL_RESPONSE":
                content = data.get("content", "")
                if "OrdersPage.tsx" in content and "diff_block_start" in content:
                    print("Found diff block!")
                    print(content[:500])
                    print("---")
        except Exception:
            pass

