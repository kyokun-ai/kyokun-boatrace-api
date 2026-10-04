キョウ君 BOATRACE AI v0.7 / DATA SYSTEM v2.5

変更点
- 過去検証のSTEP①から、日付指定できない選手コース別ページ取得を完全停止
- STEP①は過去racelistに保存された当時値のみ取得
- STEP②も同じracelistを共用（追加の選手ページ通信なし）
- /api/race の includeCourseStats 既定値をOFFへ変更し、誤取得を防止
- ③/④/⑤/Yの取得仕様と予想ロジックは変更なし
- ①/②のみの期間取得は最大31日、軽量並列24Rを維持

重要
過去バックテスト用Xには、任意の過去日を指定できない現在プロフィール系データを使用しません。


v2.5: Historical ① exports no longer contain the obsolete 1C-6C current-profile course-stat columns. Formal RAW data generation restarts from DATA-0001; prior datasets are legacy only.
