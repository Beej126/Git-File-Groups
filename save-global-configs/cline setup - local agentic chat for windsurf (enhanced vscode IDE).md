![alt text](image.png)

# model choice
- start with qwen2.5-coder:32b-instruct-q5_K_M for fast interactive - q6 seemed to overwhelm my RAM, q5 might still fit and better than q4
- switch to huihui_ai/deepseek-r1-abliterated:32b-qwen-distill-q6_K for heavy planning and problem solving
- <s>plan vs act modes in cline chat window should play into this</s> - wound up running into plan trying to act and failing in endless loop due to the permission wall, so for starters just sitting in act mode and seeing how it goes

# "feature" settings
- possibly best to DISable "Native Tool Call" to see if the default XML approach lets the search/replace work better... i was seeing consistern misses on search which AI says are due to easy whitespace misinterpretations that XML might handle better