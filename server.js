const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const XLSX = require('xlsx');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 初始化 SQLite 資料庫
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) console.error('資料庫連接失敗:', err.message);
  else console.log('已成功連接 SQLite 資料庫');
});

// 建立資料表
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS work_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration_hours REAL NOT NULL,
      hourly_rate REAL NOT NULL,
      insurance REAL DEFAULT 0,
      meal_allowance REAL DEFAULT 0,
      fee REAL DEFAULT 0,
      total_pay REAL NOT NULL,
      pay_date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// 計算薪資輔助函式
function calculatePay(start_time, end_time, hourly_rate, insurance, meal_allowance, fee) {
  const start = new Date(start_time);
  const end = new Date(end_time);
  const duration_ms = end - start;

  if (duration_ms <= 0) return null;

  const total_hours = duration_ms / (1000 * 60 * 60);
  const rate = parseFloat(hourly_rate) || 0;
  const ins = parseFloat(insurance) || 0;
  const meal = parseFloat(meal_allowance) || 0;
  const f = parseFloat(fee) || 0;

  let base_pay = 0;
  if (total_hours <= 8) {
    base_pay = total_hours * rate;
  } else {
    const regular_hours = 8;
    const overtime_hours = total_hours - 8;
    base_pay = (regular_hours * rate) + (overtime_hours * rate * 1.34);
  }

  const total_pay = Math.round(base_pay - ins + meal - f);
  return {
    total_hours: parseFloat(total_hours.toFixed(2)),
    rate, ins, meal, f, total_pay
  };
}

// 單筆新增打工紀錄 API
app.post('/api/work-logs', (req, res) => {
  const { job_name, start_time, end_time, hourly_rate, insurance, meal_allowance, fee, pay_date } = req.body;
  const calc = calculatePay(start_time, end_time, hourly_rate, insurance, meal_allowance, fee);

  if (!calc) return res.status(400).json({ error: '結束時間必須晚於開始時間' });

  const sql = `INSERT INTO work_logs (job_name, start_time, end_time, duration_hours, hourly_rate, insurance, meal_allowance, fee, total_pay, pay_date)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  db.run(sql, [job_name, start_time, end_time, calc.total_hours, calc.rate, calc.ins, calc.meal, calc.f, calc.total_pay, pay_date], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, message: '成功新增打工紀錄！' });
  });
});

// 批量新增打工紀錄 API (新增功能)
app.post('/api/work-logs/batch', (req, res) => {
  const { job_name, dates, start_time_of_day, end_time_of_day, hourly_rate, insurance, meal_allowance, fee, pay_date } = req.body;

  if (!dates || !Array.isArray(dates) || dates.length === 0) {
    return res.status(400).json({ error: '請至少選擇一個工作日期' });
  }

  const sql = `INSERT INTO work_logs (job_name, start_time, end_time, duration_hours, hourly_rate, insurance, meal_allowance, fee, total_pay, pay_date)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  let successCount = 0;
  let hasError = false;

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    const stmt = db.prepare(sql);

    for (const dateStr of dates) {
      const fullStartTime = `${dateStr}T${start_time_of_day}`;
      const fullEndTime = `${dateStr}T${end_time_of_day}`;

      const calc = calculatePay(fullStartTime, fullEndTime, hourly_rate, insurance, meal_allowance, fee);
      if (!calc) {
        hasError = true;
        break;
      }

      stmt.run([job_name, fullStartTime, fullEndTime, calc.total_hours, calc.rate, calc.ins, calc.meal, calc.f, calc.total_pay, pay_date]);
      successCount++;
    }

    if (hasError) {
      db.run("ROLLBACK");
      return res.status(400).json({ error: '時間計算有誤，請確認每日結束時間晚於開始時間' });
    } else {
      stmt.finalize();
      db.run("COMMIT", (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: `成功一次新增 ${successCount} 筆打工紀錄！` });
      });
    }
  });
});

// 修改打工紀錄 API
app.put('/api/work-logs/:id', (req, res) => {
  const { id } = req.params;
  const { job_name, start_time, end_time, hourly_rate, insurance, meal_allowance, fee, pay_date } = req.body;
  const calc = calculatePay(start_time, end_time, hourly_rate, insurance, meal_allowance, fee);

  if (!calc) return res.status(400).json({ error: '結束時間必須晚於開始時間' });

  const sql = `UPDATE work_logs 
               SET job_name = ?, start_time = ?, end_time = ?, duration_hours = ?, hourly_rate = ?, insurance = ?, meal_allowance = ?, fee = ?, total_pay = ?, pay_date = ?
               WHERE id = ?`;

  db.run(sql, [job_name, start_time, end_time, calc.total_hours, calc.rate, calc.ins, calc.meal, calc.f, calc.total_pay, pay_date, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: '成功修改紀錄！' });
  });
});

// 取得所有打工紀錄 API
app.get('/api/work-logs', (req, res) => {
  db.all('SELECT * FROM work_logs ORDER BY start_time DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 刪除單筆紀錄 API
app.delete('/api/work-logs/:id', (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM work_logs WHERE id = ?', id, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: '刪除成功' });
  });
});

// 查詢指定發薪日 API
app.get('/api/pay-date-check', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: '請提供要查詢的發薪日期' });

  const sql = `SELECT * FROM work_logs WHERE pay_date = ? ORDER BY start_time ASC`;
  db.all(sql, [date], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const totalAmount = rows.reduce((sum, item) => sum + item.total_pay, 0);
    res.json({ pay_date: date, count: rows.length, total_amount: totalAmount, details: rows });
  });
});

// 匯出 Excel API
app.get('/api/export-excel', (req, res) => {
  db.all('SELECT * FROM work_logs ORDER BY start_time ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });

    const exportData = rows.map(item => ({
      '工作名稱': item.job_name,
      '開始時間': item.start_time.replace('T', ' '),
      '結束時間': item.end_time.replace('T', ' '),
      '總時數 (小時)': item.duration_hours,
      '時薪': item.hourly_rate,
      '保費扣除': item.insurance,
      '餐費補助': item.meal_allowance,
      '手續費扣除': item.fee,
      '發薪日期': item.pay_date || '未填寫',
      '實領總薪資': item.total_pay
    }));

    const worksheet = XLSX.utils.json_to_sheet(exportData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "打工薪資明細");

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=parttime_work_logs.xlsx');
    res.send(buffer);
  });
});

// 取得指定月份（或雙月）總薪資 API
app.get('/api/stats/monthly', (req, res) => {
  const { year, months } = req.query; // 例如 year=2026, months=8 或 months=7,8
  
  if (!year || !months) {
    return res.status(400).json({ error: '請提供年份與月份參數' });
  }

  const monthArray = months.split(',').map(m => m.padStart(2, '0'));
  // 建立 SQL 篩選條件，比對 pay_date 或 start_time 的月份
  const placeholders = monthArray.map(() => '?').join(',');
  
  const sql = `
    SELECT 
      SUM(total_pay) as grand_total,
      SUM(duration_hours) as total_hours,
      COUNT(*) as shift_count
    FROM work_logs 
    WHERE strftime('%Y', start_time) = ? 
      AND strftime('%m', start_time) IN (${placeholders})
  `;

  db.get(sql, [year, ...monthArray], (err, row) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json({
      grand_total: row.grand_total || 0,
      total_hours: row.total_hours || 0,
      shift_count: row.shift_count || 0
    });
  });
});

app.listen(PORT, () => {
  console.log(`打工記帳系統已啟動: http://localhost:${PORT}`);
});
