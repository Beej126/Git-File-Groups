- set VOLTA_FEATURE_PNPM=1

- volta install pnpm@latest
  - this didn't work on my system, maybe bad residuals...
  - there's files in c:\program files\volta for all the main tools node, pnmp, etc but those seem to be wrong...
  - AI advice was to create hardlinks from c:\program files\volta-shim.exe to node.exe, pnpm.exe etc in %LOCALAPPDATA%\Volta\bin

- now these went smoother...
- (fyi these put project specific tool version dependency settings in package.json - supposedly a good thing =)
  ```
  volta pin node@lts
  volta pin pnpm@latest
  ```