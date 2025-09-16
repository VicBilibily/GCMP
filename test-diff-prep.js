// 测试 gcmp_applyDiffV2 工具的聊天集成
// 用简单的 diff 测试

const diff = `<<<<<<< SEARCH
function testFunction() {
    return 'This function will be modified to test the chat integration';
}
=======
function testFunction() {
    return 'This function has been MODIFIED to test the chat integration with NEW CONTENT';
}
>>>>>>> REPLACE`;

console.log('准备测试 diff 应用...');
console.log('Diff content:', diff);