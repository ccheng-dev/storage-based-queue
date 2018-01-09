
    function SendEmail() {

}

SendEmail.prototype.retry = 2;
SendEmail.prototype.handle = function(args) {
  try {
      return new Promise((resolve, reject) => {
        // console.log('hellooo', args);
        resolve(true);
      });
    } catch(e) {
      reject('rejected')
    }
};

Queue.register([
  {handler: SendEmail}
]);

const queue = new Queue({
  prefix: 'sq_jobsx',
  timeout: 1000,
  limit: 1,
  principle: Queue.FIFO,
  debug: true
});

queue.setLimit(-1);
// queue.setDebug(true);
queue.setPrefix('hello');

queue.on('email-sender:before', function() {
   console.log('test-3 beforeeee');
});

queue.on('email-sender:after', function() {
   console.log('test-3 after');
});

queue.on('email-sender:*', function() {
   console.log('test-3 wildcard');
});

queue.on('*', function () {
  console.log('wild card');
});

const channelA = queue.create('mailing');

channelA.start();
setTimeout(() => {
channelA.add({
  handler: 'SendEmail',
  tag: 'email-sender',
  args: {email: 'johndoe@example.com', fullname: 'John Doe 1'}
});
}, 1);

setTimeout(() => {
channelA.add({
  handler: 'SendEmail',
  args: {email: 'johndoe@example.com', fullname: 'John Doe 2'}
});
},2);

setTimeout(() => {
channelA.add({
  handler: 'SendEmail',
  args: {email: 'johndoe@example.com', fullname: 'John Doe 3'}
});
}, 3);

setTimeout(() => {
channelA.add({
  handler: 'SendEmail',
  args: {email: 'johndoe@example.com', fullname: 'John Doe 4'}
});
},4);

setTimeout(() => {
channelA.add({
  handler: 'SendEmail',
  args: {email: 'johndoe@example.com', fullname: 'John Doe 5'},
  priority: 10
});
}, 5);
