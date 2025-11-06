// const { Telegraf, Markup } = require('telegraf');

// const bot = new Telegraf('7657303430:AAFcAvZyozDWKDiM-EMxT2mD_tHx_yWIqXA'); // Замени на токен бота
// const adminId = '1301142907'; // Замени на Telegram ID админа (число)

// bot.start(async (ctx) => {
//   const startParam = ctx.startPayload; // Параметр из /start
//   if (!startParam) {
//     return ctx.reply('Добро пожаловать! Пожалуйста, используйте сайт для выбора билетов.');
//   }

//   // Парсим параметр: tickets_1,2,3_sum_4000
//   const [ticketsPart, sumPart] = startParam.split('_sum_');
//   const tickets = ticketsPart.split('_')[1].split(',');
//   const sum = parseInt(sumPart, 10);

//   // Просим номер телефона
//   await ctx.reply('Вы пришли с сайта. Пожалуйста, поделитесь номером телефона для связи.', 
//     Markup.keyboard([Markup.button.contactRequest('Поделиться номером')]).oneTime().resize()
//   );

//   // Сохраняем данные в контексте (или используй сессию, но для простоты - в глобальном, лучше используй Telegraf session)
//   ctx.session = { tickets, sum }; // Включи middleware session: bot.use(Telegraf.session());
// });

// bot.on('contact', async (ctx) => {
//   const phone = ctx.message.contact.phone_number;
//   const user = ctx.from.username || ctx.from.id;
//   const { tickets, sum } = ctx.session || {};

//   if (!tickets || !sum) {
//     return ctx.reply('Ошибка: данные о билетах не найдены.');
//   }

//   // Удаляем клавиатуру
//   await ctx.reply('Спасибо за номер!', Markup.removeKeyboard());

//   // Отправляем админу
//   const message = `Заявка с сайта:\nЮзер: @${user} (ID: ${ctx.from.id})\nНомер телефона: ${phone}\nБилеты: ${tickets.join(', ')}\nСумма к оплате: ${sum} ₽`;

//   await bot.telegram.sendMessage(adminId, message, Markup.inlineKeyboard([
//     [Markup.button.callback('Подтвердить', 'confirm_' + ctx.from.id), Markup.button.callback('Отклонить', 'reject_' + ctx.from.id)]
//   ]));
// });

// // Обработка inline кнопок (callback_query)
// bot.action(/confirm_(.+)/, async (ctx) => {
//   const userId = ctx.match[1];
//   await ctx.reply('Заявка подтверждена.'); // Админу
//   await bot.telegram.sendMessage(userId, 'Ваша заявка подтверждена!'); // Пользователю
//   await ctx.answerCbQuery();
// });

// bot.action(/reject_(.+)/, async (ctx) => {
//   const userId = ctx.match[1];
//   await ctx.reply('Заявка отклонена.'); // Админу
//   await bot.telegram.sendMessage(userId, 'Ваша заявка отклонена.'); // Пользователю
//   await ctx.answerCbQuery();
// });

// // Middleware для сессий (добавь перед bot.start)
// bot.use(Telegraf.session());

// bot.launch();
// console.log('Бот запущен');




// bot.js
const TelegramBot = require('node-telegram-bot-api');

const token = '7657303430:AAFcAvZyozDWKDiM-EMxT2mD_tHx_yWIqXA';          // ← ВСТАВЬ СВОЙ ТОКЕН
const adminId = 1301142907;               // ← ВСТАВЬ СВОЙ Telegram ID (число)
const bot = new TelegramBot(token, { polling: true });

// Хранилище данных пользователей (вместо сессий)
const userData = {};

bot.onText(/\/start (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const payload = match[1]; // например: tickets_1,2,3_sum_4000

  // Парсим payload
  const [_, ticketsStr, sumStr] = payload.split('_');
  const tickets = ticketsStr.split(',');
  const sum = parseInt(sumStr.replace('sum', ''), 10);

  // Сохраняем данные
  userData[chatId] = { tickets, sum, username: msg.from.username || 'без юзернейма' };

  bot.sendMessage(chatId, 'Вы пришли с сайта розыгрыша Mercedes!\n\nПоделитесь номером телефона для связи:', {
    reply_markup: {
      keyboard: [[{ text: 'Отправить номер', request_contact: true }]],
      one_time_keyboard: true,
      resize_keyboard: true
    }
  });
});

bot.on('contact', (msg) => {
  const chatId = msg.chat.id;
  const phone = msg.contact.phone_number;
  const data = userData[chatId];

  if (!data) {
    return bot.sendMessage(chatId, 'Ошибка: данные не найдены. Начните с сайта.');
  }

  // Убираем клавиатуру
  bot.sendMessage(chatId, 'Спасибо! Ваша заявка отправлена админу.', {
    reply_markup: { remove_keyboard: true }
  });

  // Сообщение админу
  const adminText = `
Новая заявка с сайта!

Юзер: @${data.username} (ID: ${chatId})
Телефон: ${phone}
Билеты: ${data.tickets.join(', ')}
Сумма: ${data.sum} ₽
  `.trim();

  bot.sendMessage(adminId, adminText, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Подтвердить', callback_data: `confirm_${chatId}` },
          { text: 'Отклонить', callback_data: `reject_${chatId}` }
        ]
      ]
    }
  });

  // Очищаем данные (чтобы не повторялось)
  delete userData[chatId];
});

bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const userId = query.data.split('_')[1];

  if (query.data.startsWith('confirm_')) {
    bot.sendMessage(userId, 'Ваша заявка подтверждена! Скоро с вами свяжемся.');
    bot.answerCallbackQuery(query.id, { text: 'Подтверждено' });
  }

  if (query.data.startsWith('reject_')) {
    bot.sendMessage(userId, 'Ваша заявка отклонена.');
    bot.answerCallbackQuery(query.id, { text: 'Отклонено' });
  }
});

// Если просто /start без параметра
bot.onText(/\/start/, (msg) => {
  if (!msg.text.includes(' ')) {
    bot.sendMessage(msg.chat.id, 'Привет! Перейди на сайт и выбери билеты: https://твой-сайт.рф');
  }
});

console.log('Бот запущен @Booioooodksisk_bot');