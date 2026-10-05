import 'package:peer_messaging_app/messaging/message_model.dart';
import 'package:peer_messaging_app/storage/database.dart';

class MessageService {
  static Future<void> save(MessageModel message) async {
    await AppDatabase.insertMessage(message);
  }

  static Future<List<MessageModel>> loadForContact(String contactId) async {
    return AppDatabase.messagesFor(contactId);
  }
}
