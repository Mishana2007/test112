const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');

const token = '7662270320:AAFoChJyUvtp4mC3Kd4euSVl-6OZIyQs_wo';
const admins = [1301142907, 6256380233, 434167356, 7580840734];
const bot = new TelegramBot(token, { polling: true });
const app = express();
const port = 3000;

// БД
const dbPath = path.join(__dirname, 'tickets.db');
const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS tickets (
    number INTEGER PRIMARY KEY,
    status TEXT DEFAULT 'available'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    buyer_tg_id TEXT NOT NULL,
    buyer_username TEXT,
    buyer_phone TEXT NOT NULL,
    purchase_date TEXT NOT NULL,
    tickets TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS pending_purchases (
    tg_id TEXT PRIMARY KEY,
    username TEXT,
    phone TEXT,
    tickets TEXT NOT NULL,
    sum INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS users (
    tg_id TEXT PRIMARY KEY,
    username TEXT
  )`);

  // Инициализация билетов
  db.get('SELECT COUNT(*) as count FROM tickets', (err, row) => {
    if (row.count === 0) {
      for (let i = 1; i <= 1000; i++) {
        db.run('INSERT INTO tickets (number) VALUES (?)', [i]);
      }
      console.log('Билеты 1-1000 созданы');
    }
  });
});

// API: список sold билетов
app.get('/api/tickets/sold', (req, res) => {
  db.all("SELECT number FROM tickets WHERE status = 'sold'", (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows.map(row => row.number));
  });
});

// Статические файлы
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const adminSessions = {};

// ФИКС: Обработка нового формата /start с параметром
bot.onText(/\/start (.+)/, (msg, match) => {
  const chatId = msg.chat.id.toString();
  const payload = match[1].trim();

  console.log('Payload from start:', payload);

  // Обрабатываем новый формат: t1-2-3_s6000
  if (!payload.includes('_s')) {
    return bot.sendMessage(chatId, 'Неверный формат параметра. Попробуйте снова с сайта.');
  }

  // Разбираем новый формат: t1-2-3_s6000
  const [ticketsPart, sumPart] = payload.split('_s');
  const ticketsStr = ticketsPart.replace('t', '').trim();
  
  // ФИКС: Разбираем билеты через дефис
  const tickets = ticketsStr.split('-').map(t => parseInt(t.trim())).filter(t => !isNaN(t));
  const sum = parseInt(sumPart, 10) || 0;
  const username = msg.from.username || 'без юзернейма';

  console.log('Parsed tickets:', tickets);
  console.log('Parsed sum:', sum);

  if (tickets.length === 0) {
    return bot.sendMessage(chatId, 'Ошибка: не выбраны билеты или неверный формат.');
  }

  // Сохраняем пользователя для рассылки
  db.run(`INSERT OR REPLACE INTO users (tg_id, username) VALUES (?, ?)`, [chatId, username], (err) => {
    if (err) console.error('Ошибка сохранения пользователя:', err);
  });

  // Сохраняем pending без phone
  db.run(
    `INSERT OR REPLACE INTO pending_purchases (tg_id, username, tickets, sum) VALUES (?, ?, ?, ?)`,
    [chatId, username, JSON.stringify(tickets), sum],
    err => { 
      if (err) {
        console.error('Ошибка pending start:', err);
        return bot.sendMessage(chatId, 'Ошибка при сохранении заявки.');
      }
      
      console.log('Pending сохранен:', { chatId, tickets, sum });
      
      bot.sendMessage(chatId, `🎫 Вы выбрали билеты: ${tickets.join(', ')}\n💰 Сумма: ${sum} ₽\n\n📞 Поделитесь номером телефона для связи:`, {
        reply_markup: {
          keyboard: [[{ text: '📱 Отправить номер', request_contact: true }]],
          one_time_keyboard: true,
          resize_keyboard: true
        }
      });
    }
  );
});

// Простой /start
bot.onText(/\/start$/, (msg) => {
  const chatId = msg.chat.id;
  const keyboard = admins.includes(chatId) ? [['Админка']] : [];
  bot.sendMessage(chatId, 'Привет! Выбери билеты на сайте.', {
    reply_markup: { keyboard, resize_keyboard: true }
  });
});

// Команда /admin
bot.onText(/\/admin/, (msg) => {
  const chatId = msg.chat.id;
  if (!admins.includes(chatId)) return bot.sendMessage(chatId, 'Доступ запрещён.');
  showAdminPanel(chatId);
});

// Контакт (телефон)
bot.on('contact', (msg) => {
  const chatId = msg.chat.id.toString();
  const phone = msg.contact.phone_number;

  console.log('Получен контакт от:', chatId, 'Телефон:', phone);

  // Обновляем phone в pending
  db.run(
    `UPDATE pending_purchases SET phone = ? WHERE tg_id = ?`,
    [phone, chatId],
    err => {
      if (err) {
        console.error('Ошибка update phone:', err);
        return bot.sendMessage(chatId, 'Ошибка при обновлении телефона.');
      }

      // Берём данные из pending
      db.get(`SELECT * FROM pending_purchases WHERE tg_id = ?`, [chatId], (err, row) => {
        if (err || !row) {
          console.error('Данные не найдены для:', chatId);
          return bot.sendMessage(chatId, 'Ошибка: данные не найдены.');
        }

        const tickets = JSON.parse(row.tickets);
        const sum = row.sum;
        const username = row.username;

        console.log('Отправляем заявку админам:', { tickets, sum, username, phone });

        bot.sendMessage(chatId, '✅ Спасибо! Заявка отправлена. Ожидайте подтверждения оплаты.', { 
          reply_markup: { remove_keyboard: true } 
        });

        const adminText = `
🎫 Новая заявка!

👤 Юзер: @${username} (ID: ${chatId})
📞 Телефон: ${phone}
🎟️ Билеты: ${tickets.join(', ')}
💰 Сумма: ${sum} ₽
        `.trim();

        admins.forEach(admin => {
          bot.sendMessage(admin, adminText, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✅ Подтвердить оплату', callback_data: `confirm_${chatId}` },
                  { text: '❌ Отклонить', callback_data: `reject_${chatId}` }
                ]
              ]
            }
          });
        });
      });
    }
  );
});

// Callback для подтверждения/отклонения
bot.on('callback_query', (query) => {
  const parts = query.data.split('_');
  const action = parts[0];
  const userId = parts[1];

  console.log('Callback received:', { action, userId });

  db.get(`SELECT * FROM pending_purchases WHERE tg_id = ?`, [userId], (err, row) => {
    if (err || !row) {
      console.error('Заявка не найдена для callback:', userId);
      bot.answerCallbackQuery(query.id, { text: 'Ошибка: заявка не найдена' });
      return;
    }

    const tickets = JSON.parse(row.tickets);
    console.log('Обрабатываем заявку:', { action, userId, tickets });

    if (action === 'confirm') {
      // Проверка: все ли билеты available
      const placeholders = tickets.map(() => '?').join(',');
      
      if (placeholders) {
        db.all(`SELECT number FROM tickets WHERE number IN (${placeholders}) AND status = 'available'`, tickets, (err, available) => {
          if (err) {
            console.error('Ошибка проверки билетов:', err);
            admins.forEach(admin => bot.sendMessage(admin, `❌ Ошибка БД при проверке билетов для заявки ${userId}`));
            bot.answerCallbackQuery(query.id, { text: 'Ошибка БД' });
            return;
          }

          if (available.length !== tickets.length) {
            const soldTickets = tickets.filter(t => !available.some(a => a.number === t));
            console.log(`Некоторые билеты уже проданы: ${soldTickets.join(', ')}`);
            
            admins.forEach(admin => bot.sendMessage(admin, `❌ Ошибка: Билеты ${soldTickets.join(', ')} уже проданы. Заявка ${userId} не подтверждена.`));
            bot.sendMessage(userId, `❌ Заявка не подтверждена: билеты ${soldTickets.join(', ')} уже заняты.`);
            bot.answerCallbackQuery(query.id, { text: 'Ошибка: билеты заняты' });
            
            // Удаляем pending
            db.run(`DELETE FROM pending_purchases WHERE tg_id = ?`, [userId]);
            return;
          }

          // Все билеты доступны - подтверждаем
          const mskDate = new Intl.DateTimeFormat('ru-RU', {
            timeZone: 'Europe/Moscow',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
          }).format(new Date());

          // Сохраняем в purchases
          db.run(
            `INSERT INTO purchases (buyer_tg_id, buyer_username, buyer_phone, purchase_date, tickets) VALUES (?, ?, ?, ?, ?)`,
            [row.tg_id, row.username, row.phone, mskDate, row.tickets],
            err => { 
              if (err) console.error('Ошибка purchases:', err);
            }
          );

          // Обновляем статус билетов
          const stmt = db.prepare("UPDATE tickets SET status = 'sold' WHERE number = ?");
          tickets.forEach(num => stmt.run(num));
          stmt.finalize();
          
          console.log(`✅ Билеты ${tickets.join(', ')} проданы для ${userId}`);

          bot.sendMessage(userId, '✅ Оплата подтверждена! Спасибо за покупку!');
          admins.forEach(admin => bot.sendMessage(admin, `✅ Заявка ${userId} подтверждена. Билеты: ${tickets.join(', ')}.`));
          bot.answerCallbackQuery(query.id, { text: 'Подтверждено' });

          // Удаляем pending
          db.run(`DELETE FROM pending_purchases WHERE tg_id = ?`, [userId]);
        });
      } else {
        bot.answerCallbackQuery(query.id, { text: 'Нет билетов для подтверждения' });
      }
    }

    if (action === 'reject') {
      bot.sendMessage(userId, '❌ Заявка отклонена администратором.');
      admins.forEach(admin => bot.sendMessage(admin, `❌ Заявка ${userId} отклонена.`));
      bot.answerCallbackQuery(query.id, { text: 'Отклонено' });
      
      // Удаляем pending
      db.run(`DELETE FROM pending_purchases WHERE tg_id = ?`, [userId]);
    }
  });
});

// Функция для показа админ-панели
function showAdminPanel(chatId) {
  bot.sendMessage(chatId, 'Админ-панель:', {
    reply_markup: {
      keyboard: [
        ['📊 База данных', '📢 Рассылка'],
        ['❌ Отменить']
      ],
      resize_keyboard: true
    }
  });
}

// Обработка текстовых сообщений для админа
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (!admins.includes(chatId)) return;

  if (msg.text === 'Админка') {
    showAdminPanel(chatId);
    return;
  }

  if (msg.text === '📊 База данных') {
    generateExcelAndSend(chatId);
    return;
  }

  if (msg.text === '📢 Рассылка') {
    adminSessions[chatId] = { step: 'text', text: '', photo: null };
    bot.sendMessage(chatId, 'Введите текст для рассылки:');
    return;
  }

  if (msg.text === '❌ Отменить') {
    delete adminSessions[chatId];
    bot.sendMessage(chatId, 'Действие отменено.', {
      reply_markup: { keyboard: [['Админка']], resize_keyboard: true }
    });
    return;
  }

  // Шаги рассылки
  if (adminSessions[chatId]) {
    const session = adminSessions[chatId];

    if (session.step === 'text') {
      session.text = msg.text;
      session.step = 'photo';
      bot.sendMessage(chatId, 'Хотите добавить фото? Отправьте фото или нажмите "Без фото".', {
        reply_markup: { keyboard: [['📷 Без фото'], ['❌ Отменить']], resize_keyboard: true }
      });
      return;
    }

    if (session.step === 'photo' && msg.text === '📷 Без фото') {
      session.photo = null;
      session.step = 'confirm';
      bot.sendMessage(chatId, `📝 Текст рассылки: ${session.text}\n🖼️ Фото: нет\n\nОтправить?`, {
        reply_markup: { keyboard: [['✅ Отправить'], ['❌ Отменить']], resize_keyboard: true }
      });
      return;
    }

    if (session.step === 'confirm' && msg.text === '✅ Отправить') {
      // Получаем всех users
      db.all('SELECT tg_id FROM users', async (err, rows) => {
        if (err) return bot.sendMessage(chatId, 'Ошибка БД.');

        let successCount = 0;
        let errorCount = 0;

        for (const row of rows) {
          try {
            if (session.photo) {
              await bot.sendPhoto(row.tg_id, session.photo, { caption: session.text });
            } else {
              await bot.sendMessage(row.tg_id, session.text);
            }
            successCount++;
          } catch (e) {
            console.error(`Ошибка отправки ${row.tg_id}:`, e);
            errorCount++;
          }
        }
        
        bot.sendMessage(chatId, `📢 Рассылка завершена:\n✅ Успешно: ${successCount}\n❌ Ошибок: ${errorCount}`);
      });
      delete adminSessions[chatId];
      bot.sendMessage(chatId, 'Вернуться в админку?', {
        reply_markup: { keyboard: [['Админка']], resize_keyboard: true }
      });
      return;
    }
  }
});

// Обработка фото для рассылки
bot.on('photo', (msg) => {
  const chatId = msg.chat.id;
  if (!admins.includes(chatId) || !adminSessions[chatId] || adminSessions[chatId].step !== 'photo') return;

  const session = adminSessions[chatId];
  session.photo = msg.photo[msg.photo.length - 1].file_id;
  session.step = 'confirm';
  bot.sendMessage(chatId, `📝 Текст: ${session.text}\n🖼️ Фото: да\n\nОтправить?`, {
    reply_markup: { keyboard: [['✅ Отправить'], ['❌ Отменить']], resize_keyboard: true }
  });
});

// Функция для генерации Excel и отправки
function generateExcelAndSend(chatId) {
  const wb = XLSX.utils.book_new();

  // Лист purchases
  db.all('SELECT * FROM purchases', (err, rows) => {
    if (err) {
      console.error('Ошибка БД purchases:', err);
      return bot.sendMessage(chatId, 'Ошибка БД при получении purchases.');
    }
    
    const data = rows.map(row => ({
      ID: row.id,
      'TG ID': row.buyer_tg_id,
      Username: row.buyer_username,
      Phone: row.buyer_phone,
      Date: row.purchase_date,
      Tickets: row.tickets
    }));
    const wsPurchases = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, wsPurchases, 'Purchases');

    // Лист tickets
    db.all('SELECT * FROM tickets', (err, tRows) => {
      if (err) {
        console.error('Ошибка БД tickets:', err);
        return bot.sendMessage(chatId, 'Ошибка БД при получении tickets.');
      }
      
      const tData = tRows.map(tRow => ({
        Number: tRow.number,
        Status: tRow.status
      }));
      const wsTickets = XLSX.utils.json_to_sheet(tData);
      XLSX.utils.book_append_sheet(wb, wsTickets, 'Tickets');

      // Сохраняем файл
      const excelPath = './db_export.xlsx';
      try {
        XLSX.writeFile(wb, excelPath);
        bot.sendDocument(chatId, excelPath).then(() => {
          fs.unlinkSync(excelPath);
        }).catch(err => {
          console.error('Ошибка отправки Excel:', err);
          bot.sendMessage(chatId, 'Ошибка отправки Excel.');
        });
      } catch (e) {
        console.error('Ошибка создания Excel:', e);
        bot.sendMessage(chatId, 'Ошибка создания Excel файла.');
      }
    });
  });
}

// Обработка ошибок
bot.on('error', (error) => {
  console.error('Ошибка бота:', error);
});

// Запуск
app.listen(port, () => {
  console.log(`Сервер на http://localhost:${port}`);
  console.log('Бот запущен');
});



// const express = require('express');
// const sqlite3 = require('sqlite3').verbose();
// const TelegramBot = require('node-telegram-bot-api');
// const path = require('path');
// const fs = require('fs');
// const XLSX = require('xlsx');

// const token = '7657303430:AAFcAvZyozDWKDiM-EMxT2mD_tHx_yWIqXA'; // Твой токен
// const admins = [1301142907,6256380233 /* второй админ ID, например 123456789 */]; // Массив админов
// const bot = new TelegramBot(token, { polling: true });
// const app = express();
// const port = 3000; // Порт для сайта

// // БД
// const db = new sqlite3.Database('./tickets.db');
// db.serialize(() => {
//   // Таблица билетов
//   db.run(`CREATE TABLE IF NOT EXISTS tickets (
//     number INTEGER PRIMARY KEY,
//     status TEXT DEFAULT 'available'
//   )`);

//   // Таблица покупок
//   db.run(`CREATE TABLE IF NOT EXISTS purchases (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     buyer_tg_id TEXT NOT NULL,
//     buyer_username TEXT,
//     buyer_phone TEXT NOT NULL,
//     purchase_date TEXT NOT NULL,
//     tickets TEXT NOT NULL  -- JSON array, e.g. '[1,2,3]'
//   )`);

//   // Временная таблица для pending заявок (защита от потери данных)
//   db.run(`CREATE TABLE IF NOT EXISTS pending_purchases (
//     tg_id TEXT PRIMARY KEY,
//     username TEXT,
//     phone TEXT,
//     tickets TEXT NOT NULL,  -- JSON
//     sum INTEGER NOT NULL
//   )`);

//   // Таблица пользователей для рассылки
//   db.run(`CREATE TABLE IF NOT EXISTS users (
//     tg_id TEXT PRIMARY KEY,
//     username TEXT
//   )`);

//   // Инициализация билетов
//   db.get('SELECT COUNT(*) as count FROM tickets', (err, row) => {
//     if (row.count === 0) {
//       for (let i = 1; i <= 1000; i++) {
//         db.run('INSERT INTO tickets (number) VALUES (?)', [i]);
//       }
//       console.log('Билеты 1-1000 созданы');
//     }
//   });
// });

// // API: список sold билетов (readonly, безопасно)
// app.get('/api/tickets/sold', (req, res) => {
//   db.all("SELECT number FROM tickets WHERE status = 'sold'", (err, rows) => {
//     if (err) return res.status(500).json({ error: 'DB error' });
//     res.json(rows.map(row => row.number));
//   });
// });

// // Статические файлы (теперь из корня папки)
// app.use(express.static(__dirname));

// // Обслуживание index.html на корне
// app.get('/', (req, res) => {
//   res.sendFile(path.join(__dirname, 'index.html'));
// });

// // Хранилище для админ-расслыки (временное, по сессии)
// const adminSessions = {}; // { adminId: { step: 'text' | 'photo' | 'confirm', text: '', photo: '' } }

// // /start с параметром
// bot.onText(/\/start (.+)/, (msg, match) => {
//   const chatId = msg.chat.id.toString();
//   const payload = match[1].trim();

//   console.log('Payload from start:', payload); // Лог для отладки

//   if (!payload.includes('_sum_')) {
//     return bot.sendMessage(chatId, 'Неверный формат параметра. Попробуйте снова с сайта.');
//   }

//   const [ticketsPart, sumPart] = payload.split('_sum_');
//   const ticketsStr = ticketsPart.replace('tickets_', '').trim();
//   const tickets = ticketsStr ? ticketsStr.split(',').map(t => t.trim()).filter(t => t && !isNaN(parseInt(t))) : [];
//   const sum = parseInt(sumPart, 10) || 0;
//   const username = msg.from.username || 'без юзернейма';

//   console.log('Parsed tickets:', tickets); // Лог для отладки

//   if (tickets.length === 0) {
//     return bot.sendMessage(chatId, 'Ошибка: не выбраны билеты или неверный формат.');
//   }

//   // Сохраняем пользователя для рассылки
//   db.run(`INSERT OR REPLACE INTO users (tg_id, username) VALUES (?, ?)`, [chatId, username]);

//   // Сохраняем pending без phone
//   db.run(
//     `INSERT OR REPLACE INTO pending_purchases (tg_id, username, tickets, sum) VALUES (?, ?, ?, ?)`,
//     [chatId, username, JSON.stringify(tickets), sum],
//     err => { if (err) console.error('Ошибка pending start:', err); }
//   );

//   bot.sendMessage(chatId, 'Вы пришли с сайта. Поделитесь номером телефона для связи:', {
//     reply_markup: {
//       keyboard: [[{ text: 'Отправить номер', request_contact: true }]],
//       one_time_keyboard: true,
//       resize_keyboard: true
//     }
//   });
// });

// // Простой /start
// bot.onText(/\/start$/, (msg) => {
//   const chatId = msg.chat.id;
//   const keyboard = admins.includes(chatId) ? [['Админка']] : [];
//   bot.sendMessage(chatId, 'Привет! Выбери билеты на сайте: http://твой-домен.рф', {
//     reply_markup: { keyboard, resize_keyboard: true }
//   });
// });

// // Команда /admin
// bot.onText(/\/admin/, (msg) => {
//   const chatId = msg.chat.id;
//   if (!admins.includes(chatId)) return bot.sendMessage(chatId, 'Доступ запрещён.');
//   showAdminPanel(chatId);
// });

// // Контакт (телефон)
// bot.on('contact', (msg) => {
//   const chatId = msg.chat.id.toString();
//   const phone = msg.contact.phone_number;

//   // Обновляем phone в pending
//   db.run(
//     `UPDATE pending_purchases SET phone = ? WHERE tg_id = ?`,
//     [phone, chatId],
//     err => {
//       if (err) return console.error('Ошибка update phone:', err);

//       // Берём данные из pending
//       db.get(`SELECT * FROM pending_purchases WHERE tg_id = ?`, [chatId], (err, row) => {
//         if (err || !row) return bot.sendMessage(chatId, 'Ошибка: данные не найдены.');

//         const tickets = JSON.parse(row.tickets);
//         const sum = row.sum;
//         const username = row.username;

//         bot.sendMessage(chatId, 'Спасибо! Заявка отправлена.', { reply_markup: { remove_keyboard: true } });

//         const adminText = `
// Новая заявка!

// Юзер: @${username} (ID: ${chatId})
// Телефон: ${phone}
// Билеты: ${tickets.join(', ')}
// Сумма: ${sum} ₽
//         `.trim();

//         admins.forEach(admin => {
//           bot.sendMessage(admin, adminText, {
//             reply_markup: {
//               inline_keyboard: [
//                 [
//                   { text: 'Подтвердить оплату', callback_data: `confirm_${chatId}` },
//                   { text: 'Отклонить', callback_data: `reject_${chatId}` }
//                 ]
//               ]
//             }
//           });
//         });
//       });
//     }
//   );
// });

// // Callback для подтверждения/отклонения
// bot.on('callback_query', (query) => {
//   const parts = query.data.split('_');
//   const action = parts[0];
//   const userId = parts[1];

//   db.get(`SELECT * FROM pending_purchases WHERE tg_id = ?`, [userId], (err, row) => {
//     if (err || !row) {
//       bot.answerCallbackQuery(query.id, { text: 'Ошибка: заявка не найдена' });
//       return;
//     }

//     const tickets = JSON.parse(row.tickets);

//     if (action === 'confirm') {
//       // Проверка: все ли билеты available (защита от race-condition)
//       const placeholders = tickets.map(() => '?').join(',');
//       if (placeholders) {
//         db.all(`SELECT number FROM tickets WHERE number IN (${placeholders}) AND status = 'available'`, tickets, (err, available) => {
//           if (err || available.length !== tickets.length) {
//             admins.forEach(admin => bot.sendMessage(admin, `Ошибка: Некоторые билеты уже проданы. Заявка ${userId} не подтверждена.`));
//             bot.sendMessage(userId, 'Заявка не подтверждена: билеты уже заняты.');
//             bot.answerCallbackQuery(query.id, { text: 'Ошибка: билеты заняты' });
//             db.run(`DELETE FROM pending_purchases WHERE tg_id = ?`, [userId]);
//             return;
//           }

//           // Дата MSK
//           const mskDate = new Intl.DateTimeFormat('ru-RU', {
//             timeZone: 'Europe/Moscow',
//             year: 'numeric', month: '2-digit', day: '2-digit',
//             hour: '2-digit', minute: '2-digit', second: '2-digit',
//             timeZoneName: 'short'
//           }).format(new Date()).replace(/(\d{2})\.(\d{2})\.(\d{4}), (\d{2}:\d{2}:\d{2}) GMT\+3/, '$3-$2-$1T$4+03:00');

//           // Сохраняем в purchases
//           db.run(
//             `INSERT INTO purchases (buyer_tg_id, buyer_username, buyer_phone, purchase_date, tickets) VALUES (?, ?, ?, ?, ?)`,
//             [row.tg_id, row.username, row.phone, mskDate, row.tickets],
//             err => { if (err) console.error('Ошибка purchases:', err); }
//           );

//           // Обновляем tickets
//           const stmt = db.prepare("UPDATE tickets SET status = 'sold' WHERE number = ?");
//           tickets.forEach(num => stmt.run(num));
//           stmt.finalize();
//           console.log(`Билеты ${tickets} sold для ${userId}`);

//           bot.sendMessage(userId, 'Оплата подтверждена! Спасибо.');
//           admins.forEach(admin => bot.sendMessage(admin, `Заявка ${userId} подтверждена. Билеты ${tickets.join(', ')}.`));
//           bot.answerCallbackQuery(query.id, { text: 'Подтверждено' });
//         });
//       } else {
//         bot.answerCallbackQuery(query.id, { text: 'Нет билетов для подтверждения' });
//       }
//     }

//     if (action === 'reject') {
//       bot.sendMessage(userId, 'Заявка отклонена.');
//       admins.forEach(admin => bot.sendMessage(admin, `Заявка ${userId} отклонена.`));
//       bot.answerCallbackQuery(query.id, { text: 'Отклонено' });
//     }

//     // Удаляем pending
//     db.run(`DELETE FROM pending_purchases WHERE tg_id = ?`, [userId]);
//   });
// });

// // Функция для показа админ-панели
// function showAdminPanel(chatId) {
//   bot.sendMessage(chatId, 'Админ-панель:', {
//     reply_markup: {
//       keyboard: [
//         ['База данных', 'Рассылка'],
//         ['Отменить']
//       ],
//       resize_keyboard: true
//     }
//   });
// }

// // Обработка текстовых сообщений для админа
// bot.on('message', (msg) => {
//   const chatId = msg.chat.id;
//   if (!admins.includes(chatId)) return;

//   if (msg.text === 'Админка') {
//     showAdminPanel(chatId);
//     return;
//   }

//   if (msg.text === 'База данных') {
//     // Генерируем Excel
//     generateExcelAndSend(chatId);
//     return;
//   }

//   if (msg.text === 'Рассылка') {
//     adminSessions[chatId] = { step: 'text', text: '', photo: null };
//     bot.sendMessage(chatId, 'Введите текст для рассылки:');
//     return;
//   }

//   if (msg.text === 'Отменить') {
//     delete adminSessions[chatId];
//     bot.sendMessage(chatId, 'Действие отменено.', {
//       reply_markup: { keyboard: [['Админка']], resize_keyboard: true }
//     });
//     return;
//   }

//   // Шаги рассылки
//   if (adminSessions[chatId]) {
//     const session = adminSessions[chatId];

//     if (session.step === 'text') {
//       session.text = msg.text;
//       session.step = 'photo';
//       bot.sendMessage(chatId, 'Хотите добавить фото? Отправьте фото или нажмите "Без фото".', {
//         reply_markup: { keyboard: [['Без фото'], ['Отменить']], resize_keyboard: true }
//       });
//       return;
//     }

//     if (session.step === 'photo' && msg.text === 'Без фото') {
//       session.photo = null;
//       session.step = 'confirm';
//       bot.sendMessage(chatId, `Текст рассылки: ${session.text}\nФото: нет\nОтправить?`, {
//         reply_markup: { keyboard: [['Отправить'], ['Отменить']], resize_keyboard: true }
//       });
//       return;
//     }

//     if (session.step === 'confirm' && msg.text === 'Отправить') {
//       // Получаем всех users
//       db.all('SELECT tg_id FROM users', async (err, rows) => {
//         if (err) return bot.sendMessage(chatId, 'Ошибка БД.');

//         for (const row of rows) {
//           try {
//             if (session.photo) {
//               await bot.sendPhoto(row.tg_id, session.photo, { caption: session.text });
//             } else {
//               await bot.sendMessage(row.tg_id, session.text);
//             }
//           } catch (e) {
//             console.error(`Ошибка отправки ${row.tg_id}:`, e);
//           }
//         }
//         bot.sendMessage(chatId, 'Рассылка отправлена.');
//       });
//       delete adminSessions[chatId];
//       bot.sendMessage(chatId, 'Вернуться в админку?', {
//         reply_markup: { keyboard: [['Админка']], resize_keyboard: true }
//       });
//       return;
//     }
//   }
// });

// // Обработка фото для рассылки
// bot.on('photo', (msg) => {
//   const chatId = msg.chat.id;
//   if (!admins.includes(chatId) || !adminSessions[chatId] || adminSessions[chatId].step !== 'photo') return;

//   const session = adminSessions[chatId];
//   session.photo = msg.photo[msg.photo.length - 1].file_id; // Самое большое фото
//   session.step = 'confirm';
//   bot.sendMessage(chatId, `Текст: ${session.text}\nФото: да\nОтправить?`, {
//     reply_markup: { keyboard: [['Отправить'], ['Отменить']], resize_keyboard: true }
//   });
// });

// // Функция для генерации Excel и отправки
// function generateExcelAndSend(chatId) {
//   const wb = XLSX.utils.book_new();

//   // Лист purchases
//   db.all('SELECT * FROM purchases', (err, rows) => {
//     if (err) return bot.sendMessage(chatId, 'Ошибка БД.');
//     const data = rows.map(row => ({
//       ID: row.id,
//       'TG ID': row.buyer_tg_id,
//       Username: row.buyer_username,
//       Phone: row.buyer_phone,
//       Date: row.purchase_date,
//       Tickets: row.tickets
//     }));
//     const wsPurchases = XLSX.utils.json_to_sheet(data);
//     XLSX.utils.book_append_sheet(wb, wsPurchases, 'Purchases');

//     // Лист tickets
//     db.all('SELECT * FROM tickets', (err, tRows) => {
//       if (err) return bot.sendMessage(chatId, 'Ошибка БД.');
//       const tData = tRows.map(tRow => ({
//         Number: tRow.number,
//         Status: tRow.status
//       }));
//       const wsTickets = XLSX.utils.json_to_sheet(tData);
//       XLSX.utils.book_append_sheet(wb, wsTickets, 'Tickets');

//       // Сохраняем файл
//       const excelPath = './db_export.xlsx';
//       XLSX.writeFile(wb, excelPath);
//       bot.sendDocument(chatId, excelPath, {}, { filename: 'db_export.xlsx' }).then(() => {
//         fs.unlinkSync(excelPath); // Удаляем временный файл
//       }).catch(err => {
//         console.error('Ошибка отправки Excel:', err);
//         bot.sendMessage(chatId, 'Ошибка отправки Excel.');
//       });
//     });
//   });
// }

// // Запуск
// app.listen(port, () => {
//   console.log(`Сервер на http://localhost:${port}`);
//   console.log('Бот запущен');
// });